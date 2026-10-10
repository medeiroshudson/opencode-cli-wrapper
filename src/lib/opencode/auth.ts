// The wrapper authenticates with one upstream credential (the host's opencode auth),
// so there is no per-request credential to extract: an AuthContext only says whether
// the caller presented one.
export interface AuthContext {
  enabled: boolean;
  token: string | null;
}
