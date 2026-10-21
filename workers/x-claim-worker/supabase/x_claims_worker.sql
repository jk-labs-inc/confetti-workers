alter table public.social_links enable row level security;
alter table public.claims_history enable row level security;

grant x_claims_worker to authenticator;
grant usage on schema public to x_claims_worker;

grant select, insert on public.social_links to x_claims_worker;
grant update (
  handle,
  verified,
  verified_type,
  is_identity_verified,
  subscription_type,
  verified_followers_count,
  followers_count,
  following_count,
  post_count,
  account_created_at,
  updated_at
) on public.social_links to x_claims_worker;

grant select, insert on public.claims_history to x_claims_worker;
grant update (status, tx_hash) on public.claims_history to x_claims_worker;

create policy x_claims_worker_select on public.social_links
  for select to x_claims_worker using (true);
create policy x_claims_worker_insert on public.social_links
  for insert to x_claims_worker with check (true);
create policy x_claims_worker_update on public.social_links
  for update to x_claims_worker using (true) with check (true);

create policy x_claims_worker_select on public.claims_history
  for select to x_claims_worker using (true);
create policy x_claims_worker_insert on public.claims_history
  for insert to x_claims_worker with check (status in ('pending', 'failed', 'rejected'));
create policy x_claims_worker_settle on public.claims_history
  for update to x_claims_worker using (status = 'pending') with check (status in ('paid', 'failed'));
