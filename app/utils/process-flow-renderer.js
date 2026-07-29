const P2PWorkflowUtils = {
	// Standardized steps with their corresponding Zoho Page links
	PROCESS_STEPS: [
		{
			key: "purchase_requisition",
			label: "PR",
			icon: "bi-receipt",
			page: "PR_Approval",
		},
		{
			key: "request_for_quotation",
			label: "RFQ",
			icon: "bi-bucket",
			page: "Request_For_Quotations",
		},
		{
			key: "quote_comparison",
			label: "Comparison",
			icon: "bi-shop-window",
			page: "Quote_Comparisons",
		},
		{
			key: "purchase_order",
			label: "PO",
			icon: "bi-cart-check",
			page: "Purchase_Orders",
		},
		{ key: "grn", label: "GRN", icon: "bi-box-seam", page: "GRN_Listing" },
		{ key: "bill", label: "Bill", icon: "bi-coin", page: "Bills" },
		{ key: "payment", label: "Payment", icon: "bi-cash", page: "Payments" },
	],

	// Base API names without environment prefix.
	// Use getApiName(key) to get the fully-prefixed name at runtime.
	_API_BASE_NAMES: {
		FETCH_PR_DETAILS: "Fetch_PR_Details",
		FETCH_RFQ_DETAILS: "Get_RFQ_Details",
		FETCH_QC_DETAILS: "Fetch_Vendor_Comparison_Details",
		SEND_RFQ_EMAIL_TO_VENDOR: "Send_RFQ_Email_To_Vendor",
		CHECK_ITEM_IN_GRN: "Check_Vendor_Requirement_For_Item",
		FETCH_PO_DETAILS: "Fetch_PO_Details",
		FETCH_GRN_DETAILS: "Fetch_GRN_Details",
		FETCH_LOGIN_USER: "Me",
	},
	ROLES: {
		PRODUCTION: "Production Team",
		OPERATIONS: "Operations Team",
		PURCHASE: "Purchase Team",
	},
	// Level-1 cache: in-memory (cleared on page refresh).
	_loginUser: null,
	// Level-2 cache: localStorage key used to persist the login user across page navigations.
	_LOGIN_USER_CACHE_KEY: "p2p_login_user_cache",
	// How long the localStorage cache is considered fresh (default: 4 hours).
	_LOGIN_USER_CACHE_TTL_MS: 4 * 60 * 60 * 1000,

	// Resolved prefix — set by init(), defaults to "Dev__" until resolved.
	_envPrefix: "Dev__",

	// Promise that resolves once the environment prefix has been detected.
	// Await this before calling getApiName() in critical paths.
	_envReady: null,

	/**
	 * Detect the current Zoho Creator environment and cache the API prefix.
	 * Call once on widget load (e.g. in ZOHO.CREATOR.init callback).
	 *
	 * Uses ZOHO.CREATOR.UTIL.getInitParams() — the response includes
	 * `envUrlFragment` (e.g. "/environment/development" or "/environment/production").
	 *
	 * @returns {Promise<string>} Resolves to the active prefix ("Dev__" | "Prod__").
	 */
	init: async function () {
		if (this._envReady) return this._envReady;

		this._envReady = (async () => {
			try {
				const response = await ZOHO.CREATOR.UTIL.getInitParams();
				const fragment = (response && response.envUrlFragment) || "";
				// Development environment contains "development" in the fragment
				const isDev = fragment.toLowerCase().includes("development");
				this._envPrefix = isDev ? "Dev__" : "Prod__";
				return this._envPrefix;
			} catch {
				// Fallback: keep default "Dev__" on error to avoid
				// accidentally calling production APIs in unknown environments.
				this._envPrefix = "Dev__";
				return this._envPrefix;
			}
		})();

		return this._envReady;
	},

	/**
	 * Returns the fully-prefixed custom API name for the given key.
	 * Make sure init() has been awaited before calling this.
	 *
	 * @param {string} key - A key from _API_BASE_NAMES (e.g. "FETCH_PR_DETAILS")
	 * @returns {string} e.g. "Dev__Fetch_PR_Details" or "Prod__Fetch_PR_Details"
	 */
	getApiName: function (key) {
		const base = this._API_BASE_NAMES[key];
		if (!base) {
			console.warn(`P2PWorkflowUtils.getApiName: unknown key "${key}"`);
			return key;
		}
		return this._envPrefix + base;
	},

	/**
	 * A live map of all custom API names with the correct environment prefix applied.
	 * Use this in HTML/JS instead of hardcoding string keys.
	 *
	 * Example:
	 *   api_name: P2PWorkflowUtils.API.FETCH_PR_DETAILS
	 *   // → "Dev__Fetch_PR_Details"  (development)
	 *   // → "Prod__Fetch_PR_Details" (production)
	 *
	 * @returns {{ [key: string]: string }}
	 */
	get API() {
		const prefix = this._envPrefix;
		return Object.fromEntries(
			Object.entries(this._API_BASE_NAMES).map(([k, v]) => [
				k,
				prefix + v,
			]),
		);
	},
	// Helper: Map Creator Stage Strings to Step Keys
	stageToStepKey: function (stage) {
		if (!stage) return null;
		const s = stage.toLowerCase().trim();
		if (s.includes("purchase requisition")) return "purchase_requisition";
		if (s.includes("request for quotation")) return "request_for_quotation";
		if (s.includes("quote comparison")) return "quote_comparison";
		if (s.includes("purchase order")) return "purchase_order";
		if (s.includes("grn")) return "grn";
		if (s.includes("bill")) return "bill";
		if (s.includes("payment")) return "payment";
		return null;
	},

	// Helper: Escape HTML to prevent XSS
	esc: function (str) {
		if (str == null || str === "") return "–";
		const div = document.createElement("div");
		div.textContent = String(str);
		return div.innerHTML;
	},
	formatDateForZoho(dateStr) {
		if (!dateStr) return "";
		const months = [
			"Jan",
			"Feb",
			"Mar",
			"Apr",
			"May",
			"Jun",
			"Jul",
			"Aug",
			"Sep",
			"Oct",
			"Nov",
			"Dec",
		];
		const d = new Date(dateStr + "T00:00:00"); // force local time parse
		if (isNaN(d.getTime())) return dateStr;
		return (
			String(d.getDate()).padStart(2, "0") +
			"-" +
			months[d.getMonth()] +
			"-" +
			d.getFullYear()
		);
	},

	// Main Function 1: Render Clickable Progress Stepper
	renderProgress: function (actions, fallbackStage, containerEl, fillEl) {
		if (!containerEl || !fillEl) return;

		let currentStageKey = null;
		let rejectedStepKey = null;
		let lastStatusApproved = false;

		// 1. Single Source of Truth: The Last Action
		if (actions && Array.isArray(actions) && actions.length > 0) {
			// Sort ascending by Zoho ID
			const sortedActions = [...actions].sort(
				(a, b) => (parseInt(a.ID) || 0) - (parseInt(b.ID) || 0),
			);

			// Get the absolute last action
			const lastAction = sortedActions[sortedActions.length - 1];

			// Extract the true current stage
			currentStageKey = this.stageToStepKey(lastAction.Moved_To);

			// Track whether the last action was approved
			if (lastAction.Status) {
				const lastStatusLower = lastAction.Status.toLowerCase();
				// If the last action was a rejection, mark this specific stage as rejected
				if (lastStatusLower === "rejected") {
					rejectedStepKey = currentStageKey;
				}
				// If last action was approved, the current step should show as completed (green)
				if (lastStatusLower === "approved") {
					lastStatusApproved = true;
				}
			}
		}

		// 2. Fallback (Only fires if PR_Actions is entirely empty)
		if (!currentStageKey) {
			currentStageKey =
				this.stageToStepKey(fallbackStage) || "purchase_requisition";
		}

		// 3. Map to Index
		let currentIdx = this.PROCESS_STEPS.findIndex(
			(s) => s.key === currentStageKey,
		);
		if (currentIdx === -1) currentIdx = 0; // Fallback to start if mapping fails

		let rejectedIdx = -1;
		if (rejectedStepKey) {
			rejectedIdx = this.PROCESS_STEPS.findIndex(
				(s) => s.key === rejectedStepKey,
			);
		}

		const isRejected = rejectedIdx !== -1;
		const fillIdx = isRejected ? rejectedIdx : currentIdx;

		// 4. Generate HTML
		let stepsHtml = "";
		this.PROCESS_STEPS.forEach((step, i) => {
			const isRejectedStep = i === rejectedIdx;

			// If it's a rejected state, only elements BEFORE the rejected index are done
			// If it's normal, everything up to and including currentIdx is "done" (or current)
			const isDone = isRejected ? i < rejectedIdx : i <= currentIdx;
			// isCurrent is true only if this is the active step AND the last status is NOT approved
			const isCurrent =
				i === currentIdx && !isRejectedStep && !lastStatusApproved;
			let circleClass, labelClass;
			if (isRejectedStep) {
				circleClass =
					"bg-red-600 text-white border-red-600 shadow-md shadow-red-200";
				labelClass = "text-red-700 font-semibold";
			} else if (isDone && isCurrent) {
				// Active step — in progress (blue)
				circleClass =
					"bg-[#1B5CA8] text-white border-[#1B5CA8] shadow-md shadow-blue-200";
				labelClass = "text-[#1B5CA8] font-semibold";
			} else if (isDone) {
				// Completed step (including current step when last status is Approved) — green
				circleClass = "bg-emerald-600 text-white border-emerald-600";
				labelClass = "text-gray-700 font-medium";
			} else {
				circleClass = "bg-white text-gray-400 border-gray-300";
				labelClass = "text-gray-400";
			}

			// Show green check for: all prior done steps AND current step if last status is Approved
			const showCheckIcon = isDone && !isCurrent;
			const iconHtml = isRejectedStep
				? '<i class="bi bi-x-lg text-[13px]"></i>'
				: showCheckIcon
					? '<i class="bi bi-check-lg text-[13px]"></i>'
					: `<i class="bi ${step.icon} text-[13px]"></i>`;

			const stepLabel = isRejectedStep ? "Rejected" : step.label;

			// Clickable Logic
			let clickAttr = "";
			let cursorClass = "";
			if (isDone || isCurrent) {
				clickAttr = `onclick="ZOHO.CREATOR.UTIL.navigateParentURL({action:'open',window:'same',url:'#Page:${step.page}'})" title="Go to ${step.label}"`;
				cursorClass =
					"cursor-pointer hover:scale-110 hover:shadow-lg transition-transform";
			}

			stepsHtml += `
                <div class="flex flex-col items-center relative z-10" style="width: ${100 / this.PROCESS_STEPS.length}%">
                    <button type="button" ${clickAttr} class="w-[30px] h-[30px] rounded-full border-2 flex items-center justify-center text-[13px] ${circleClass} transition-all duration-300 ${cursorClass} outline-none">
                        ${iconHtml}
                    </button>
                    <div class="text-[10px] mt-1.5 text-center leading-tight ${labelClass}">${stepLabel}</div>
                </div>`;
		});

		// Clean up old steps and inject new ones
		const oldSteps = containerEl.querySelectorAll(".flex.flex-col");
		oldSteps.forEach((el) => el.remove());
		containerEl.insertAdjacentHTML("beforeend", stepsHtml);

		// Set Fill Bar
		fillEl.style.width = `${(fillIdx / (this.PROCESS_STEPS.length - 1)) * 100}%`;
		fillEl.style.background = isRejected ? "#dc2626" : "#1B5CA8";
	},

	/**
	 * Fetch the currently logged-in Zoho user's details via the "Dev_Me" custom API.
	 *
	 * The result is cached after the first successful call so that subsequent calls
	 * within the same widget session are instant and never hit the network again.
	 *
	 * @returns {Promise<{
	 *   loginuserid: string,
	 *   email: string,
	 *   username: string,
	 *   role: string,
	 *   permission: string
	 * }>} Resolves with the logged-in user object.
	 *
	 * @throws {Error} If the API call fails or returns an unexpected payload.
	 *
	 * @example
	 *   const user = await P2PWorkflowUtils.fetchLoginUser();
	 *   console.log(user.role);        // "Super Admin"
	 *   console.log(user.email);       // "zohoone@apcobuildingsolutions.com"
	 */
	fetchLoginUser: async function () {
		// ── Level 1: in-memory (same page session) ──────────────────────────────
		if (this._loginUser) return this._loginUser;

		// ── Level 2: localStorage (survives navigation, expires after TTL) ──────
		try {
			const raw = localStorage.getItem(this._LOGIN_USER_CACHE_KEY);
			if (raw) {
				const cached = JSON.parse(raw);
				const age = Date.now() - (cached.cachedAt || 0);
				if (
					age < this._LOGIN_USER_CACHE_TTL_MS &&
					cached.user &&
					cached.user.loginuserid
				) {
					this._loginUser = cached.user; // promote to in-memory
					return this._loginUser;
				}
				// Cache expired — remove stale entry
				localStorage.removeItem(this._LOGIN_USER_CACHE_KEY);
			}
		} catch (_) {
			// localStorage may be unavailable (private mode, quota, etc.) — silently continue
		}

		// ── Level 3: fetch from Zoho custom API ─────────────────────────────────
		try {
			const response = await ZOHO.CREATOR.DATA.invokeCustomApi({
				api_name: this.API.FETCH_LOGIN_USER,
				http_method: "GET",
				content_type: "application/json",
			});

			// The SDK may wrap the payload under .result, .data, or return it directly.
			let user = response;
			if (response && response.result) user = response.result;
			else if (response && response.data) user = response.data;

			// If the value is still a JSON string, parse it.
			if (typeof user === "string") {
				try {
					user = JSON.parse(user);
				} catch (_) {
					/* leave as-is */
				}
			}

			if (!user || typeof user !== "object" || !user.loginuserid) {
				throw new Error(
					"fetchLoginUser: unexpected response shape — " +
						JSON.stringify(response),
				);
			}

			// Persist to localStorage with a timestamp for TTL checks
			try {
				localStorage.setItem(
					this._LOGIN_USER_CACHE_KEY,
					JSON.stringify({ user, cachedAt: Date.now() }),
				);
			} catch (_) {
				// localStorage write failed (quota exceeded, etc.) — not critical
			}

			this._loginUser = user;
			return this._loginUser;
		} catch (err) {
			console.error("P2PWorkflowUtils.fetchLoginUser error:", err);
			throw err;
		}
	},

	async downloadFile(filePath, reportName, recordId) {
		if (typeof filePath === "string" && filePath.includes("filepath=")) {
			filePath = filePath.split("filepath=")[1].split("&")[0];
		}
		try {
			const initParams = await ZOHO.CREATOR.UTIL.getInitParams();
			const { scope, envUrlFragment, appLinkName } = initParams;
			const url =
				`https://creatorapp.zoho.in/${scope}${envUrlFragment}/${appLinkName}` +
				`/report/${reportName}/${recordId}/Attachments/download-file` +
				`?filepath=${encodeURIComponent(filePath)}`;

			window.open(url, "_blank");
		} catch (err) {
			console.error("Could not get init params:", err);
		}
	},
};
