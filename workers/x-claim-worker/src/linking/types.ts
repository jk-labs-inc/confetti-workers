import type { SocialLinkRow } from "../supabase/types";

export interface XLoginState {
  address: string;
  codeVerifier: string;
  origin: string;
  returnPath: string;
  browserBinding: string;
}

export type LinkResult = { kind: "linked"; link: SocialLinkRow } | { kind: "linked_elsewhere" };
