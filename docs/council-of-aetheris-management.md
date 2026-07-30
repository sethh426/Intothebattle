# Council of Aetheris Management Guide

The Council of Aetheris is the IntoTheBattle referral and ambassador program.
It is built around the official founding offer: creators earn $3 every month for every paid IntoTheBattle subscription they bring in, for as long as that referred subscription stays active.

## Official Offer

- Referred plan: paid IntoTheBattle subscription at $8.50/month.
- Referrer reward: $3/month per active paid subscription.
- Founding-window lock: referrals made while the Council is open keep the $3/month reward rate forever while their payments stay active.
- Example monthly earnings: 10 paid referrals = $30/month, 50 = $150/month, 100 = $300/month.
- Recruit bonus: a creator you sign up can claim one full year of IntoTheBattle free after they refer 25 paid subscribers of their own.
- Council Elite / Aetherarch is appointed only.

## What Is Automated

- Creator referral codes and share links.
- Referral click tracking from `/r/:code`.
- Signup attribution for email and Google signups.
- Self-referral blocking when the referred user is the same account as the code owner.
- PayPal subscription detection for active paid referrals.
- Monthly reward ledger creation for each active paid referral.
- Founding-rate lock storage on referral attribution.
- Creator dashboard/profile rank progress based on active paid referrals.
- One-year bonus claim creation when a recruited creator reaches 25 active paid referrals of their own.
- Admin CSV export for payout review.

## What You Manage Manually

- Review `/admin/referrals` at least weekly.
- Approve, reject, or mark monthly reward rows paid.
- Collect a W-9 before the first cash payout.
- Batch cash payouts monthly after the creator reaches the $25 minimum.
- Grant Discord roles, overlay skins, cosmetics, early feature access, and roadmap vote access.
- Review and grant one-year bonus claims from `/admin/referrals`.
- Appoint Council Elite / Aetherarch members manually.
- Review fraud signals: self-referral attempts, fast churn, unusual referral clusters, duplicate payment details, or suspicious traffic.

## Rank Rules

| Rank | Threshold | Operator Action |
| --- | ---: | --- |
| Aspirant | 0 active paid referrals | Creator can join free and start sharing their personal link. |
| Herald of the Aether | 3 active paid referrals | Grant exclusive overlay skin. |
| Stormcaller | 10 active paid referrals | Grant early feature access. |
| Ascendant Warden | 25 active paid referrals | Grant premium cosmetics and roadmap vote access. |
| Council Elite / Aetherarch | Appointed only | Invite manually from top Wardens after review. |

Active paid referral means the referred creator has an active paid PayPal subscription. If that subscription cancels, future monthly reward rows stop.

## Weekly Workflow

1. Open `/admin/referrals`.
2. Filter to `Pending review`.
3. Confirm the referred account is a real paid creator and the referral looks legitimate.
4. Approve legitimate monthly rewards.
5. Reject fraud, refunds, chargebacks, or suspicious activity with a short note.
6. Review one-year bonus claims and mark them approved, rejected, or granted.

## Monthly Payout Workflow

1. Export `/admin/referrals/export.csv`.
2. Group approved rewards by referrer.
3. Pay only creators with at least $25 approved cash balance.
4. Confirm W-9 collection before the first cash payment.
5. Mark paid monthly reward rows as `paid`.
6. Review cancellations before payment so inactive referred subscriptions do not keep accruing future rewards.

## One-Year Bonus Workflow

1. A recruited creator reaches 25 active paid referrals of their own.
2. The system creates a pending one-year bonus claim.
3. Open `/admin/referrals` and review the claim.
4. Choose `granted` only after confirming the referrals are legitimate.
5. The admin action cancels any active PayPal subscription for that creator, then grants 12 months of Council Year Free access.

## Guardrails

- The program is free to join.
- Rewards are paid only for real paid subscriptions, not for recruiting ambassadors.
- Ambassadors must disclose that they can earn a reward.
- Do not publish income guarantees or imply typical earnings.
- Do not approve self-referrals.
- Confirm tax and payout handling with a CPA or attorney before scaling cash payouts.
