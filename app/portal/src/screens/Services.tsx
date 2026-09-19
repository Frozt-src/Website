import { useEffect, useState } from 'react';
import { useApi } from '../auth';
import { formatDate } from '../api';
import type { ServiceSummary } from '../api';

export default function Services() {
  const api = useApi();
  const [services, setServices] = useState<ServiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .services()
      .then(result => {
        if (!cancelled) setServices(result);
      })
      .catch(() => {
        if (!cancelled) setError('We could not load your services.');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <section className="portal-section" aria-labelledby="services-title">
      <h1 id="services-title">Services</h1>
      {error && (
        <p className="portal-error" role="alert">
          {error}
        </p>
      )}
      {!error && !services && (
        <p className="portal-meta" role="status">
          Loading…
        </p>
      )}
      {services && services.length === 0 && (
        <p className="portal-meta" role="status">
          No services on file.
        </p>
      )}
      {services && services.length > 0 && (
        <ul className="portal-list">
          {services.map(service => (
            <li key={service.id} className="portal-list-item">
              <div className="portal-list-heading">
                <h2>{service.name}</h2>
                <span className={`portal-status portal-status-${service.status === 'active' ? 'open' : 'void'}`}>
                  {service.status === 'active' ? 'Active' : 'Ended'}
                </span>
              </div>
              <p className="portal-meta">{service.description}</p>
              {(service.startedAt !== null || service.endedAt !== null) && (
                <p className="portal-meta">
                  {service.startedAt !== null && `Started ${formatDate(service.startedAt)}`}
                  {service.startedAt !== null && service.endedAt !== null && ' · '}
                  {service.endedAt !== null && `Ended ${formatDate(service.endedAt)}`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
