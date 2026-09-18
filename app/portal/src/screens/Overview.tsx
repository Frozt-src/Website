import { formatMoney, navigate } from '../api';
import type { MeResponse } from '../api';

export default function Overview({ me }: { me: MeResponse }) {
  return (
    <section className="portal-section" aria-labelledby="overview-title">
      <h1 id="overview-title">{me.client.name}</h1>
      <p className="portal-meta">{me.client.billingEmail}</p>
      <div className="portal-card">
        <p className="portal-eyebrow">Balance due</p>
        <p className="portal-balance">{formatMoney(me.balanceCents, 'usd')}</p>
        <button type="button" className="portal-button" onClick={() => navigate('/invoices')}>
          View invoices
        </button>
      </div>
      <p className="portal-meta">
        Signed in as {me.membership.role} · membership {me.membership.status}
      </p>
    </section>
  );
}
