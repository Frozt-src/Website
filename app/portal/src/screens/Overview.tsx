import { formatMoney } from '../api';
import type { MeResponse } from '../api';
import Link from '../Link';

// Phase 1 is usd-only and /api/me carries no per-client currency, so this names the assumption
// instead of leaving a bare 'usd' literal that reads like it could vary by client.
const DEFAULT_CURRENCY = 'usd';

const membershipRoleLabel: Record<MeResponse['membership']['role'], string> = {
  owner: 'Owner',
  member: 'Member',
};

export default function Overview({ me }: { me: MeResponse }) {
  return (
    <section className="portal-section" aria-labelledby="overview-title">
      <h1 id="overview-title">{me.client.name}</h1>
      <p className="portal-meta">{me.client.billingEmail}</p>
      <div className="portal-card">
        <p className="portal-eyebrow">Balance due</p>
        <p className="portal-balance">{formatMoney(me.balanceCents, DEFAULT_CURRENCY)}</p>
        <Link href="/invoices" className="portal-button">
          View invoices
        </Link>
      </div>
      <p className="portal-meta">Signed in as {membershipRoleLabel[me.membership.role]}</p>
    </section>
  );
}
