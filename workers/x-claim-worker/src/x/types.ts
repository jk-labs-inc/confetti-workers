export interface XProfile {
  id: string;
  username: string;
  verified: boolean | null;
  verifiedType: string | null;
  isIdentityVerified: boolean | null;
  subscriptionType: string | null;
  verifiedFollowersCount: number | null;
  followersCount: number | null;
  followingCount: number | null;
  postCount: number | null;
  createdAt: string | null;
}
