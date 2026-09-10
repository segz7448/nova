/**
 * Department Tool Profiles — merged into agent/ from backend/agent-runtime.
 *
 * MERGE NOTE (see /MERGE-NOTES.md at repo root for the full picture):
 * This module originally lived at backend/agent-runtime/src/departmentToolProfiles.ts
 * and depended on that runtime's ACTION/INPUT text-protocol tool set
 * (agent-runtime/src/tools.ts's `Action` union). agent/'s own tool
 * dispatch (src/agent/tools.ts + harnesses/) uses a different, native
 * tool-calling shape and does not define an equivalent `Action` union,
 * so nothing here was overwritten or replaced — the `Action` type and
 * its backing `ACTIONS` list are inlined below, verbatim from
 * agent-runtime/src/tools.ts, purely so this profile table keeps
 * compiling and stays inspectable on its own.
 *
 * Follow-up wiring (not done as part of this merge): map each `Action`
 * name here to the equivalent tool name(s) in agent/src/agent/tools.ts,
 * or change `CAPABILITY_TO_ACTIONS` to key on agent/'s native tool
 * identifiers directly. Until that happens, `resolveProfileActions()`
 * below returns agent-runtime action names, not agent/ tool names.
 */

const ACTIONS = [
  "check_balance",
  "run_command",
  "write_file",
  "read_file",
  // next-phase.md Phase 8a (architecture-agent.md §4d/§4e's own
  // "internet intelligence"/"web search" capability names, real
  // runtime primitives at last): this runtime had ZERO structured
  // internet-access ACTION before this phase — not even at the
  // unrestricted Agent tier, which could only reach the open internet
  // via raw `run_command curl`/`wget` if the sandbox image happens to
  // have one installed. Ported from `agent/src/agent/tools.ts`'s own
  // long-standing `web_fetch`/`web_search`/`github_read` (the
  // self-hosted CLI package's tool set), adapted to this runtime's
  // plain-string-ACTION dispatch shape rather than that package's
  // richer per-tool `execute()` closures — same adaptation shape every
  // other ACTION in this file already takes relative to its own
  // conceptual origin (e.g. `check_balance` vs. that package's wallet
  // tools).
  "web_search",
  "web_fetch",
  "github_read",
  "pty_create",
  "pty_write",
  "pty_read",
  "pty_close",
  "pty_list",
  "spawn_clone",
  "spawn_subagent",
  "subagent_pty_create",
  "subagent_status",
  "subagent_list",
  "subagent_result",
  "kill_subagent",
  "create_department",
  "set_department_network",
  "spawn_department_worker",
  "department_list",
  "get_department_tree",
  "retire_department",
  "spawn_temp_workers",
  "retire_project",
  "project_burns",
  "department_knowledge",
  "rename_department",
  "delete_department",
  "transfer_department_budget",
  "move_worker",
  "change_worker_role",
  "convert_temp_to_permanent",
  // next-phase.md Phase 2f-iii (architecture-agent.md §4e, Department
  // management): create_project, break_into_tasks, assign_task,
  // evaluate_worker, retain_worker, terminate_temp_worker — plus their
  // three read-path siblings (list_projects, list_tasks,
  // get_worker_evaluations), same "every capability gets its own
  // ACTION, including pure reads" pattern project_burns/
  // department_knowledge/department_list already established.
  "create_project",
  "list_projects",
  "break_into_tasks",
  "list_tasks",
  "assign_task",
  "evaluate_worker",
  "retain_worker",
  "get_worker_evaluations",
  "terminate_temp_worker",
  "register_erc8004",
  "check_onchain_identity",
  "remember",
  "recall",
  "save_procedure",
  "recall_procedure",
  "procedure_outcome",
  "learn_fact",
  "query_knowledge",
  "update_soul",
  // next-phase.md Phase 2i(e) (architecture-agent.md §7 addition): the
  // one new ACTION this phase adds. See executeTool()'s own comment for
  // why it's deliberately exempt from the profile-check gate below,
  // unlike every other ACTION in this list.
  "list_available_tools",
  // next-phase.md Phase 3a (architecture-agent.md §3): the creation
  // half of the channels state machine — the first ACTIONs that ever
  // name a *different* top-level agent as their target, rather than a
  // resource under the caller's own office. accept_channel/reject_channel
  // are deliberately only ever meaningful once the caller already knows
  // a channel_id (nothing in this sub-phase adds a way to discover one —
  // see next-phase.md's own Phase 3a scope note: "nothing yet capable of
  // reading or acting on that state" beyond accept/reject themselves).
  "propose_channel",
  "accept_channel",
  "reject_channel",
  // next-phase.md Phase 3b: the teardown half — either party (not just
  // the recipient) may revoke an active channel, or implicitly reject
  // one that's still only proposed. See channelService.ts's own doc
  // comment on revokeChannel() for why this is one ACTION covering both
  // starting statuses rather than two.
  "revoke_channel",
  // next-phase.md Phase 3d (architecture-agent.md §7): the first real
  // cross-office capability — requires an active file_transfer channel
  // (3c's checkCapability/findActiveChannelGrant), copies a file already
  // staged in your own outbox/ into the recipient's inbox/, and fails
  // closed with NO_CHANNEL rather than ever falling back to a raw copy.
  "send_file",
  // next-phase.md Phase 3e (architecture-agent.md §3/§7): asks a peer to
  // send a file — same active file_transfer channel gate send_file()
  // requires (3c/3d), but deliberately does NOT move anything itself.
  // The peer's own runtime decides, independently, whether to call
  // send_file() back; nothing here auto-grants.
  "request_file",
  // next-phase.md Phase 3f-i (architecture-agent.md §3/§7): joins a
  // joint_project-scoped channel — provisions (idempotently) a shared
  // /joint/{channel_id}/ directory bind-mounted read-write into BOTH
  // parties' own sandbox containers. Unlike send_file/request_file,
  // takes the channel_id directly rather than a `to` address; the
  // other party is derived from the channel itself.
  "join_project",
  // next-phase.md Phase 9c (architecture-agent.md §4h): Domain
  // Management's subdomain+SSL provisioning, made real and
  // dispatchable. This sub-phase's own "Touches" line originally
  // named seven granular ACTIONs (dns_create_record, dns_list_records,
  // dns_delete_record, nginx_create_vhost, nginx_delete_vhost,
  // ssl_issue_cert, ssl_renew_cert) — deliberately NOT what's exposed
  // here. Exposing DNS/vhost/cert as independently callable ACTIONs
  // would let an agent create a DNS record with no vhost behind it, or
  // a vhost with no cert, defeating this phase's own "a genuinely
  // working HTTPS URL, not just requested" done-criterion. Instead:
  // one atomic composite create (provision_subdomain, all three steps
  // + rollback on any failure), one introspection read
  // (list_subdomains), and one atomic composite teardown
  // (release_subdomain, DNS+vhost+cert cleanup +
  // domain_resources.status -> 'released' in one call). The granular
  // Cloudflare/Nginx/certbot calls still exist — as internal
  // backend/src/domains.ts functions only, never as separate ACTIONs
  // here. Same "name the deviation, don't silently build around it"
  // treatment Phase 9b's own compose file gave its
  // acme-companion-to-certbot switch.
  "provision_subdomain",
  "list_subdomains",
  "release_subdomain",
  // next-phase.md Phase 9d-i (architecture-agent.md §4h): the write
  // half of Domain Management's mailbox-provisioning tool — Mailcow
  // mailbox creation + a generated password stored encrypted, never
  // returned in this (or any) tool-call response/output string. List
  // (mail_list_mailboxes), reveal (reveal_mailbox_credential), and
  // delete (mail_delete_mailbox) are 9d-ii/9d-iii's own separate
  // ACTIONs, added below by those sub-phases rather than pre-empted
  // here.
  "mail_create_mailbox",
  // next-phase.md Phase 9d-ii (architecture-agent.md §4h): the read
  // half of Domain Management's mailbox-provisioning tool.
  // mail_list_mailboxes is a pure read (address + status, never a
  // credential — same shape list_subdomains already returns).
  // reveal_mailbox_credential is deliberately its own, separate ACTION
  // rather than folded into either mail_list_mailboxes or
  // mail_create_mailbox — the one point in the whole flow where a
  // mailbox password is actually readable, gated to the owning
  // department and logged to capability_audit every time it's called.
  "mail_list_mailboxes",
  "reveal_mailbox_credential",
  // next-phase.md Phase 9d-iii (architecture-agent.md §4h): the
  // teardown half of Domain Management's mailbox-provisioning tool —
  // Mailcow deletion + domain_resources.status -> 'released', same
  // "release the claim last" ordering discipline release_subdomain
  // already established. This closes out §4h's mailbox-provisioning
  // tool: create (9d-i), list/reveal (9d-ii), delete (9d-iii).
  "mail_delete_mailbox",
  // Dynamic tool registration — see customTools.ts's own header for why
  // this had no equivalent anywhere in this runtime before: tool_registry
  // only ever governed grants over this fixed ACTIONS array, never let an
  // agent define a genuinely new one. Agent-tier only, same way
  // "update_soul" above is Agent-tier only — by omission from
  // CAPABILITY_TO_ACTIONS/toolRegistrySeedData.ts, never granted to any
  // department_agent/worker role, so no separate gate is needed here.
  "register_tool",
  "list_registered_tools",
  "call_registered_tool",
  "remove_registered_tool",
  // Skills — ported from agent/'s SKILL.md system (agent/src/skills/).
  // Agent-tier only, same reasoning as the dynamic-tool ACTIONS above.
  "install_skill_git",
  "install_skill_url",
  "create_skill",
  "list_skills",
  "get_skill",
  "remove_skill",
  // Git self-mod — ported from agent/src/git/tools.ts. Every operation
  // is a plain `git ...` shell command run via backend.vmExec() (same
  // isolation as run_command), so this is a much more direct port than
  // skills/custom-tools were: no new backend storage or routes needed,
  // just the command construction + output parsing.
  "git_status",
  "git_diff",
  "git_commit",
  "git_log",
  "git_push",
  "git_branch",
  "git_clone",
  // Browser automation — ported from agent/src/browser/{ensure,daemon-script}.ts.
  // A resident headless-Chromium daemon gets lazily installed and
  // started INSIDE the agent's own sandbox (via vmExec), then every
  // call below just curls its localhost HTTP API — again nothing new
  // needed here beyond the port itself, since vmExec already gives
  // agent-runtime the same exec primitive agent/'s browserCall() uses.
  "browser_navigate",
  "browser_get_text",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_download",
  "browser_eval",
  "browser_close",
  "finish",
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * Department Tool Profiles (next-phase.md Phase 2f-i, architecture-agent.md §4e)
 *
 * §4e says a Department Agent's tool table "isn't one fixed list, it's
 * drawn from a per-department profile matching what that division
 * actually does" — Software / Marketing / Finance / Security / Server,
 * each with its own fixed tool list, and "a Department Agent only ever
 * gets the profile matching its own `role`... a Marketing Department
 * Agent never has terminal/git access just because the Software
 * Department Agent does."
 *
 * This file is data only: a `role` string -> `DepartmentToolProfile`
 * lookup, plus (as of Phase 2f-ii-a) the capability-name -> ACTION
 * mapping and `resolveProfileActions()` built on top of it. Nothing
 * calls `resolveProfileActions()` yet — no caller in this repo
 * consults it as of this phase. Phase 2f-ii-b/2f-ii-c are what wire it
 * into `systemPrompt.ts`'s Department Agent prompt construction and
 * `tools.ts`'s dispatch so an unauthorized tool call actually gets
 * denied, not just left off a prompt. Until then this is the locked
 * *table plus mapping*, matching Phase 2c's own sequencing pattern of
 * locking a shape before a later phase wires enforcement into it.
 *
 * `role` today is the free-text string passed to `create_department(name,
 * role)` (departments.ts) — nothing in the schema constrains it to one
 * of the five department types below (see db.ts's Phase 2f-i migration
 * comment). `lookupDepartmentToolProfile()` is therefore a normalizing
 * lookup, not a strict enum index: it matches case-insensitively against
 * each known department type's name and aliases, and anything that
 * doesn't match falls through to `DEFAULT_TOOL_PROFILE` — fail closed on
 * an unrecognized department type, never fail open to the union of every
 * profile. A typo'd or novel `role` string is exactly the case this
 * default exists for.
 *
 * next-phase.md Phase 9a-ii added a sixth department type, `domain`
 * (architecture-agent.md §4h's new Domain Management row) — same
 * fail-closed lookup, same profile shape, one more entry in
 * DEPARTMENT_TOOL_PROFILES/DEPARTMENT_TYPE_ALIASES below. Its five
 * capability names resolve to an empty ACTION[] for now (see
 * CAPABILITY_TO_ACTIONS' own "Domain Management" section further down)
 * since the DNS, SSL, reverse-proxy, and mail primitives behind them
 * don't exist in this runtime yet — 9c/9d's job, not this sub-phase's.
 */

export type DepartmentType = "software" | "marketing" | "finance" | "security" | "server" | "domain";

export interface DepartmentToolProfile {
  /** The canonical department type this profile belongs to, or null for the fail-closed default. */
  departmentType: DepartmentType | null;
  /** Human-readable label, matching architecture-agent.md §4e's table header. */
  label: string;
  /** The tool list itself, seeded verbatim from §4e's per-department table. */
  tools: string[];
}

/**
 * §4e's table, row for row. Tool names here are the plain-English
 * capability names §4e itself uses (e.g. "package manager", "CRM"),
 * not yet mapped to this runtime's specific ACTION names in
 * `tools.ts` — that mapping is Phase 2f-ii's job, once there's an
 * actual enforcement point to map them onto. Keeping this file a
 * direct, literal transcription of §4e keeps the doc and the data in
 * sync by inspection; Phase 2i's Tool Registry is what eventually
 * replaces this hand-maintained map with generated rows (see this
 * file's own supersession note in next-phase.md's Phase 2i section).
 */
const SOFTWARE_TOOLS = [
  "terminal",
  "shell",
  "file system",
  "git",
  "GitHub",
  "package manager",
  "build tools",
  "test tools",
  "debugging",
  "code analysis",
  "database",
  "API testing",
  "deployment",
  "logs",
];

const MARKETING_TOOLS = [
  "web search",
  "market research",
  "competitor research",
  "customer research",
  "content generation",
  "analytics",
  "campaign management",
  "lead research",
  "CRM",
  "customer communication",
  "product analytics",
];

const FINANCE_TOOLS = [
  "transaction history",
  "wallet balance",
  "revenue analysis",
  "expense analysis",
  "budgeting",
  "forecasting",
  "accounting",
  "payment records",
  "financial reporting",
];

const SECURITY_TOOLS = [
  "logs",
  "dependency scanning",
  "configuration inspection",
  "vulnerability testing",
  "security testing",
  "network monitoring",
  "incident analysis",
  "access auditing",
  // error-fix.md Phase 12a (Security department / Server department):
  // Finance/Security/Server are permanently network-hardened
  // (HARDENED_NETWORK_DEPARTMENT_TYPES, toolRegistry.ts) at the sandbox
  // level, but web_search/web_fetch/github_read are dispatched directly
  // from the agent-runtime process (tools.ts), never through the
  // sandbox's run_command/pty_* path — so granting them here does not
  // weaken that hardening guarantee. A Security Department Agent can
  // now actually look up a CVE or advisory instead of having zero
  // research capability of any kind.
  "vulnerability research",
];

const SERVER_TOOLS = [
  "VM management",
  "container management",
  "deployment",
  "logs",
  "monitoring",
  "scaling",
  "backups",
  "DNS",
  "network configuration",
  // error-fix.md Phase 12a: same reasoning as Security's
  // "vulnerability research" above — mediated, not sandboxed, so it's
  // safe to grant despite Server being a hardened-network department
  // type. Lets a Server Department Agent check DNS propagation, look up
  // a service's status page, etc.
  "infrastructure research",
];

// next-phase.md Phase 9a-ii (architecture-agent.md §4h's new Domain
// row): five capability names, one per Domain Management primitive
// §4h names — DNS records, SSL certs, reverse-proxy vhosts, mailbox
// provisioning, and the domain_resources registry itself (lookup/
// release). Deliberately its own row, not derived from SERVER_TOOLS
// above even though both touch "DNS" — Server's DNS entry is VM/
// network-ops-flavored (this Agent's own infrastructure), Domain's is
// apex-shared-resource-flavored (novamail.store subdomains/mailboxes
// shared across every Agent, §4h's own "one shared apex" design
// decision) — kept as two distinct capability lists per this file's
// own "profile matches what that division actually does" rule, not a
// coincidence to collapse.
const DOMAIN_TOOLS = [
  "dns record management",
  "ssl certificate issuance",
  "reverse-proxy vhost management",
  "mailbox provisioning",
  "domain-resource registry",
];

/**
 * Fail-closed default for any `role` that doesn't match a known
 * department type below — fs/exec only, per this phase's own "Done
 * when" line ("an unrecognized role gets a minimal default profile...
 * not the union of everything"). Deliberately narrower than any single
 * real department's profile, not a merge of all five.
 */
export const DEFAULT_TOOL_PROFILE: DepartmentToolProfile = {
  departmentType: null,
  label: "Default (unrecognized department type)",
  tools: ["file system", "terminal"],
};

export const DEPARTMENT_TOOL_PROFILES: Record<DepartmentType, DepartmentToolProfile> = {
  software: { departmentType: "software", label: "Software", tools: SOFTWARE_TOOLS },
  marketing: { departmentType: "marketing", label: "Marketing", tools: MARKETING_TOOLS },
  finance: { departmentType: "finance", label: "Finance", tools: FINANCE_TOOLS },
  security: { departmentType: "security", label: "Security", tools: SECURITY_TOOLS },
  server: { departmentType: "server", label: "Server", tools: SERVER_TOOLS },
  domain: { departmentType: "domain", label: "Domain Management", tools: DOMAIN_TOOLS },
};

/**
 * Aliases a `role` string may arrive as, beyond the canonical type name
 * itself (which is always matched case-insensitively regardless of this
 * list). Kept short and literal on purpose — this is a normalizing
 * lookup for the exact five §4e types, not a general fuzzy-matcher that
 * could accidentally widen what counts as e.g. "software" and grant
 * terminal/git to something that isn't really the Software department.
 */
const DEPARTMENT_TYPE_ALIASES: Record<DepartmentType, string[]> = {
  software: ["engineering", "eng", "dev", "development", "frontend", "backend"],
  marketing: ["growth", "marcomm"],
  finance: ["accounting", "fin"],
  security: ["infosec", "sec"],
  server: ["infra", "infrastructure", "devops", "ops", "sysadmin"],
  domain: ["dns", "domains", "webmaster"],
};

/**
 * role -> DepartmentToolProfile. Case-insensitive, trims whitespace.
 * Matches the canonical department type name first, then each type's
 * alias list. No match -> DEFAULT_TOOL_PROFILE, never a merged/union
 * profile — see this file's own header comment and Phase 2f-i's "Done
 * when" line.
 */
export function lookupDepartmentToolProfile(role: string | null | undefined): DepartmentToolProfile {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_TOOL_PROFILE;
  }

  if (normalized in DEPARTMENT_TOOL_PROFILES) {
    return DEPARTMENT_TOOL_PROFILES[normalized as DepartmentType];
  }

  for (const type of Object.keys(DEPARTMENT_TOOL_PROFILES) as DepartmentType[]) {
    if (DEPARTMENT_TYPE_ALIASES[type].includes(normalized)) {
      return DEPARTMENT_TOOL_PROFILES[type];
    }
  }

  return DEFAULT_TOOL_PROFILE;
}

// ─────────────────────────────────────────────────────────────────
// Phase 2f-ii-a — capability name -> ACTION mapping
// ─────────────────────────────────────────────────────────────────
//
// §4e's tables are written in plain English ("git", "package manager",
// "CRM"). This runtime doesn't expose one ACTION per real-world tool —
// it exposes a small, fixed set of primitives (run_command, pty_create,
// read_file/write_file, the memory/knowledge tools, and the
// department/worker management tools) that those real-world tools run
// *through*. So this mapping is deliberately many-to-few: most
// technical capability names ("git", "package manager", "build tools",
// "debugging", ...) resolve to the same underlying exec/pty primitives,
// because that's genuinely how a Software Department Agent would run
// git, npm, a debugger, or a test suite in this runtime — there is no
// separate "git ACTION" to point to. A handful of capability names
// (e.g. "CRM", "wallet balance") don't have ANY runtime primitive yet
// (no CRM integration exists in tools.ts) — those map to an empty
// ACTION[] on purpose, not omitted from the table and not silently
// aliased onto an unrelated tool. An empty mapping is a real, honest
// answer: "this department type is described in §4e but this specific
// capability isn't implemented in the runtime yet," which is a
// materially different fact than a typo'd/unmapped key (which fails
// loudly instead, per assertAllCapabilitiesMapped below).
export const CAPABILITY_TO_ACTIONS: Record<string, Action[]> = {
  // ── Software ──────────────────────────────────────────────────
  // Every one of these is, concretely, "run a program in the sandbox"
  // or "hold an interactive session for one" — git, npm/pip/etc,
  // compilers, test runners, debuggers, linters, and DB/API clients
  // are all just programs invoked via run_command or driven live via
  // pty_create/pty_write/pty_read/pty_close in this runtime, there is
  // no per-tool ACTION for any of them.
  terminal: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close", "pty_list"],
  shell: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close", "pty_list"],
  "file system": ["read_file", "write_file"],
  git: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  // Phase 8a: github_read is additive alongside the existing shell-based
  // path — a Software Department Agent/Worker can still run authenticated
  // `git`/`gh` commands in its own sandbox via run_command/pty_* for
  // write access (commits, pushes, PRs), but now also gets a no-auth,
  // read-only structured path for researching a repo (info/readme/
  // issues/pulls/file) without needing a `gh` CLI install or token in
  // the sandbox at all.
  github: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close", "github_read"],
  "package manager": ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  "build tools": ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  "test tools": ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  debugging: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  "code analysis": ["run_command", "read_file"],
  database: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  "api testing": ["run_command"],
  deployment: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  logs: ["run_command", "read_file"],

  // ── Marketing ─────────────────────────────────────────────────
  // Phase 8a: "web search" and every research-flavored capability below
  // it now resolve to the real web_search/web_fetch primitives added
  // this phase — previously empty because no such integration existed
  // anywhere in tools.ts (see this block's own prior comment, now
  // stale and replaced). CRM/analytics/campaign-management/lead-CRM
  // integration and "content generation" (the model's own text output,
  // not a call to anything) remain genuinely unimplemented and stay
  // empty — this phase only closes the *internet-research* half of
  // Marketing's row, not the whole thing.
  "web search": ["web_search"],
  "market research": ["web_search", "web_fetch"],
  "competitor research": ["web_search", "web_fetch"],
  "customer research": ["web_search", "web_fetch"],
  "content generation": [],
  analytics: [],
  "campaign management": [],
  "lead research": ["web_search", "web_fetch"],
  crm: [],
  "customer communication": [],
  "product analytics": [],

  // ── Finance ───────────────────────────────────────────────────
  // check_balance is the one real financial primitive this runtime
  // exposes today. Everything else on Finance's §4e row (revenue
  // analysis, forecasting, accounting, payment records, financial
  // reporting) has no dedicated backend call yet — no ledger/reporting
  // API exists in tools.ts, so these stay empty rather than being
  // stretched onto check_balance or the memory tools, which would
  // misrepresent what those primitives actually do.
  "transaction history": [],
  "wallet balance": ["check_balance"],
  "revenue analysis": [],
  "expense analysis": [],
  budgeting: [],
  forecasting: [],
  accounting: [],
  "payment records": [],
  "financial reporting": [],

  // ── Security ──────────────────────────────────────────────────
  // "logs" is shared with Software's row on purpose (same underlying
  // primitives — reading log output via run_command/read_file). The
  // remaining Security capabilities (dependency/vuln scanners,
  // dedicated security-testing tools, network monitoring, incident
  // analysis, access auditing) have no dedicated ACTION — a Security
  // Department Agent would run an actual scanner as a shell command
  // today, which IS covered (run_command/pty_*), but the *capability
  // name* itself is deliberately not force-mapped onto those unless
  // it's genuinely the same primitive Software already uses for
  // running arbitrary programs. Kept empty here rather than duplicating
  // Software's run_command/pty_* entries under a different label that
  // would blur the "what does this department actually have" picture.
  "dependency scanning": [],
  "configuration inspection": ["read_file"],
  "vulnerability testing": [],
  "security testing": [],
  "network monitoring": [],
  "incident analysis": [],
  "access auditing": [],
  // error-fix.md Phase 12a: the three mediated (agent-runtime-process,
  // not sandbox) research primitives — safe for a hardened-network
  // department because they never touch that department's own sandbox
  // network. Lets Security actually look up a CVE/advisory/patch.
  "vulnerability research": ["web_search", "web_fetch", "github_read"],

  // ── Server ────────────────────────────────────────────────────
  // "deployment" and "logs" are shared with Software's row (identical
  // underlying primitives). VM/container management, scaling, backups,
  // DNS, and network configuration have no dedicated backend call in
  // tools.ts today (no VM-orchestration or DNS-registrar integration
  // exists) — these are §4e capabilities the doc names ahead of the
  // runtime actually implementing them, so they stay empty.
  "vm management": [],
  "container management": [],
  monitoring: [],
  scaling: [],
  backups: [],
  dns: [],
  "network configuration": [],
  // error-fix.md Phase 12a: same mediated research grant as Security's
  // "vulnerability research" above. Lets Server check DNS propagation,
  // a provider's status page, etc. without touching the sandbox network.
  "infrastructure research": ["web_search", "web_fetch", "github_read"],

  // ── Domain Management ────────────────────────────────────────
  // next-phase.md Phase 9a-ii left all five as an empty ACTION[]; Phase
  // 9c wired three real dispatchable ACTIONs — provision_subdomain,
  // list_subdomains, release_subdomain — added to tools.ts's `Action`
  // union by that phase. Consolidated onto ONE capability entry
  // ("domain-resource registry") rather than spread across all three of
  // "dns record management"/"ssl certificate issuance"/"reverse-proxy
  // vhost management" individually: 9c's own naming decision (see
  // tools.ts's comment on it) deliberately did NOT expose granular
  // per-record DNS/vhost/cert ACTIONs, only the atomic composite
  // create/list/release against domain_resources — which is exactly
  // what "domain-resource registry" already names. The remaining three
  // capability names ("dns record management"/"ssl certificate
  // issuance"/"reverse-proxy vhost management") stay empty on purpose:
  // there is still no independently-callable dns_create_record/
  // ssl_issue_cert/nginx_create_vhost ACTION in this runtime, only the
  // consolidated three above.
  //
  // "mailbox provisioning" now carries Phase 9d-i's own
  // mail_create_mailbox (the write half), Phase 9d-ii's own
  // mail_list_mailboxes/reveal_mailbox_credential (the read half), and
  // Phase 9d-iii's own mail_delete_mailbox (the teardown half) — §4h's
  // mailbox-provisioning tool is now fully wired.
  "dns record management": [],
  "ssl certificate issuance": [],
  "reverse-proxy vhost management": [],
  "mailbox provisioning": [
    "mail_create_mailbox",
    "mail_list_mailboxes",
    "reveal_mailbox_credential",
    "mail_delete_mailbox",
  ],
  "domain-resource registry": ["provision_subdomain", "list_subdomains", "release_subdomain"],
};

/**
 * Every capability name that appears anywhere in §4e's five tables,
 * derived directly from DEPARTMENT_TOOL_PROFILES so this list can never
 * drift from the tables above by hand-editing one and not the other.
 * Lower-cased, since CAPABILITY_TO_ACTIONS keys are lower-case and
 * resolution (below) is case-insensitive.
 */
const ALL_CAPABILITY_NAMES: string[] = Array.from(
  new Set(
    Object.values(DEPARTMENT_TOOL_PROFILES).flatMap((profile) => profile.tools.map((t) => t.toLowerCase())),
  ),
);

/**
 * Fails loudly at module-load time if any §4e capability name has no
 * entry in CAPABILITY_TO_ACTIONS at all (as opposed to an entry that's
 * deliberately an empty array, which is allowed and means "named in
 * §4e, not yet implemented by this runtime"). An entirely *missing*
 * key is a bug — either a typo, or a new §4e capability that was never
 * added here — and per this phase's own "Done when" line, that must
 * fail loudly rather than silently resolve to an empty set the same
 * way a deliberate empty mapping would.
 */
function assertAllCapabilitiesMapped(): void {
  const unmapped = ALL_CAPABILITY_NAMES.filter((name) => !(name in CAPABILITY_TO_ACTIONS));
  if (unmapped.length > 0) {
    throw new Error(
      `departmentToolProfiles.ts: ${unmapped.length} §4e capability name(s) have no entry in ` +
        `CAPABILITY_TO_ACTIONS: ${unmapped.join(", ")}. Add an entry (an empty array is fine if no ` +
        `runtime ACTION exists yet) — an entirely missing key is treated as a mapping bug, not an ` +
        `intentional gap.`,
    );
  }
}

// Runs at import time, exactly like Phase 2f-ii-a's "Done when" line
// specifies: "an unmapped capability name should fail loudly (thrown
// error at startup/seed time), not silently resolve to an empty set."
assertAllCapabilitiesMapped();

/**
 * error-fix.md #1 fix — Worker-role narrowing (architecture-agent.md
 * §4f's "External/specialty tools" bullet: "depend entirely on the
 * worker's role, e.g.: a web researcher gets search → browser → data
 * extraction; a backend worker gets terminal → git → database → API
 * testing; a designer gets design tools → files → browser; a sales
 * worker gets web research → CRM → customer communication; a security
 * worker gets logs → scanner → test environment. These are drawn from
 * the same per-department tool profile (§4e) the Worker's Department
 * Agent has, further narrowed to just what the specific role needs —
 * a Worker never has more tool surface than its own Department Agent."
 *
 * Each entry is a SUBSET of capability names that must already appear
 * somewhere in DEPARTMENT_TOOL_PROFILES above — this table only ever
 * narrows a department's own profile, never grants a capability the
 * department profile itself doesn't already have (enforced by
 * resolveWorkerToolNames()'s intersection below, not by convention
 * alone). Role names are the five §4e/§4f worked examples plus the two
 * closest real-world specializations of "backend worker" this repo's
 * own Software profile already distinguishes (frontend vs. backend) —
 * not an exhaustive enumeration of every possible worker title. An
 * unrecognized role — including a real title that just isn't one of
 * these — falls back to the FULL department profile, unnarrowed
 * (fail OPEN to the department's own scope, never fail closed to
 * nothing): §4f says specialty tools narrow "where relevant," not that
 * every worker must match one of these buckets to get anything.
 */
const WORKER_ROLE_PROFILES: Record<string, string[]> = {
  "backend worker": [
    "terminal",
    "shell",
    "file system",
    "git",
    "package manager",
    "database",
    "API testing",
    "deployment",
    "logs",
  ],
  "frontend worker": [
    "terminal",
    "shell",
    "file system",
    "git",
    "package manager",
    "build tools",
    "test tools",
    "debugging",
  ],
  "web researcher": ["web search", "market research", "competitor research", "customer research", "lead research"],
  designer: ["file system"],
  "sales worker": ["web search", "lead research", "CRM", "customer communication"],
  "security worker": ["logs", "vulnerability testing", "security testing", "vulnerability research"],
};

/**
 * Aliases a `workerRole` string may arrive as, same normalizing-not-
 * fuzzy-matching posture as DEPARTMENT_TYPE_ALIASES above. Kept short
 * and literal — widening this casually would risk narrowing a worker
 * onto the wrong bucket silently, which is worse than not narrowing at
 * all (falling through to the full department profile is always safe;
 * matching the wrong role-profile is not).
 */
const WORKER_ROLE_ALIASES: Record<string, string[]> = {
  "backend worker": ["backend", "backend developer", "backend engineer"],
  "frontend worker": ["frontend", "frontend developer", "frontend engineer"],
  "web researcher": ["researcher", "research worker", "market researcher"],
  designer: ["design worker", "ui designer", "ux designer"],
  "sales worker": ["sales", "salesperson"],
  "security worker": ["security researcher", "vulnerability researcher"],
};

/**
 * workerRole -> the WORKER_ROLE_PROFILES key it matches, or null on no
 * match (never a made-up bucket). Case-insensitive, trims whitespace,
 * canonical name first then alias list — identical shape to
 * lookupDepartmentToolProfile()'s own matching order above.
 */
function normalizeWorkerRole(workerRole: string | null | undefined): string | null {
  const normalized = (workerRole ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized in WORKER_ROLE_PROFILES) return normalized;
  for (const key of Object.keys(WORKER_ROLE_PROFILES)) {
    if (WORKER_ROLE_ALIASES[key].includes(normalized)) return key;
  }
  return null;
}

/**
 * A Worker's actual capability-name list: its department's own profile
 * (lookupDepartmentToolProfile) intersected with the matching
 * WORKER_ROLE_PROFILES entry, when workerRole normalizes to one.
 * Intersection, not union or a bare role-profile lookup — this is what
 * makes §4f's "a Worker never has more tool surface than its own
 * Department Agent" hold even if a role profile above and a
 * department's own profile were ever edited out of sync (e.g. if
 * "security worker" is somehow requested under a Marketing department,
 * the intersection with MARKETING_TOOLS is empty, not SECURITY_TOOLS'
 * full list leaking into a department that never had it). Falls back
 * to the full, unnarrowed department profile when workerRole is
 * omitted entirely or doesn't normalize to a known role.
 */
export function resolveWorkerToolNames(
  departmentRole: string | null | undefined,
  workerRole?: string | null,
): string[] {
  const departmentProfile = lookupDepartmentToolProfile(departmentRole);
  const normalizedWorkerRole = normalizeWorkerRole(workerRole);
  if (!normalizedWorkerRole) {
    return departmentProfile.tools;
  }
  const roleCapabilities = new Set(WORKER_ROLE_PROFILES[normalizedWorkerRole].map((c) => c.toLowerCase()));
  return departmentProfile.tools.filter((tool) => roleCapabilities.has(tool.toLowerCase()));
}

/**
 * role -> concrete ACTION[], via lookupDepartmentToolProfile() ->
 * CAPABILITY_TO_ACTIONS. Deduplicated (several capability names in one
 * profile commonly share an ACTION, e.g. Software's git/package
 * manager/build tools/test tools/debugging/deployment all resolve
 * through the same pty_* primitives). This is the "resolved set" every
 * later 2f-ii sub-phase (prompt construction, dispatch enforcement,
 * fidelity tests) is defined against — always call this rather than
 * re-deriving it from lookupDepartmentToolProfile() + a second lookup
 * inline, so there's exactly one place this resolution logic lives.
 *
 * `workerRole` (error-fix.md #1 fix) is optional and additive: omitting
 * it preserves this function's exact prior behavior (department-level
 * resolution only, e.g. for a Department Agent's own prompt/dispatch)
 * — passing it narrows the result to resolveWorkerToolNames()'s
 * intersection instead, for a Worker spawned under that department.
 *
 * KNOWN LIMITATION, surfaced here rather than left implicit: because
 * this runtime's ACTION set is generic (run_command/pty_* run ANY
 * program, not one ACTION per real-world tool), Software's, Security's,
 * and Server's resolved ACTION sets all reduce to some subset of
 * run_command/pty_create/pty_write/pty_read/pty_close/pty_list/
 * read_file/write_file — the same primitives, just different subsets,
 * because "run git" and "run a vulnerability scanner" are both just
 * "run a program" at this layer. Concretely: Software's resolved set
 * and the unrecognized-role DEFAULT_TOOL_PROFILE's resolved set are
 * IDENTICAL today (terminal + file system already covers every
 * pty/run_command/read_file/write_file primitive, so Software's extra
 * capability names like git/package manager add no new ACTIONs beyond
 * what the default already grants). Marketing's empty set is the one
 * profile that's genuinely, meaningfully different at this layer — a
 * Marketing Department Agent's exec/pty calls are all rejected, but a
 * Software vs. Security vs. Server vs. unrecognized-role Department
 * Agent's exec/pty calls are NOT yet distinguishable by ACTION alone.
 * This is expected and not a bug in this phase's own scope (2f-ii-a
 * only maps capability names onto this runtime's EXISTING ACTIONs — it
 * can't invent per-tool ACTIONs that don't exist), but it means
 * 2f-ii-c's dispatch-layer enforcement can only fully separate "has any
 * exec/pty access" from "has none" until Scope (the second element of
 * §4g's Tool+Scope+Budget+Role+Environment tuple — which department's
 * own sandbox/container an exec call is allowed to touch) is enforced
 * alongside Tool. Flagging explicitly rather than leaving 2f-ii-c to
 * discover this by surprise: enforcing ACTION-only, as scoped here, is
 * a real but partial narrowing (Marketing and Finance-minus-check_balance
 * are fully separated from Software/Security/Server/default), not the
 * full per-department separation §4e's prose implies on its own.
 */
export function resolveProfileActions(role: string | null | undefined, workerRole?: string | null): Action[] {
  const capabilityNames = workerRole !== undefined ? resolveWorkerToolNames(role, workerRole) : lookupDepartmentToolProfile(role).tools;
  const actions = new Set<Action>();
  for (const capabilityName of capabilityNames) {
    const mapped = CAPABILITY_TO_ACTIONS[capabilityName.toLowerCase()];
    // Every capability name in a profile is guaranteed present in
    // CAPABILITY_TO_ACTIONS by assertAllCapabilitiesMapped() above
    // (which runs at import time) — this branch only exists so a
    // future edit that adds a tool to a DEPARTMENT_TOOL_PROFILES list
    // without a matching mapping entry fails the same way at the call
    // site too, not just at import.
    if (!mapped) {
      throw new Error(
        `resolveProfileActions: capability "${capabilityName}" (role "${role}") has no entry in ` +
          `CAPABILITY_TO_ACTIONS — this should be impossible if assertAllCapabilitiesMapped() ran.`,
      );
    }
    for (const action of mapped) actions.add(action);
  }
  return Array.from(actions);
}
