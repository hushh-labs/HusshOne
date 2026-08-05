// Legacy alias — the upstream turned out to be Nationwide's own keyless `search-api`, not a
// direct Yext call, so the client lives in nationwide.mjs. This re-export exists only so any
// stale import keeps working; prefer importing from ./nationwide.mjs.
export * from "./nationwide.mjs";
