const apiBase = (import.meta.env.VITE_API_URL || 'https://api.mnlith.dev').replace(/\/+$/, '')

export const site = {
  name: 'Monolith',
  domain: 'mnlith.dev',
  contactEmail: 'eldritch@mnlith.dev',
  inquiryUrl: apiBase.endsWith('/inquiries') ? apiBase : `${apiBase}/inquiries`,
}

export const services = [
  { id: 'managed-it', title: 'Managed IT', line: 'Keep the everyday working.', description: 'Thoughtful support for the technology your team depends on. Bring devices, access, and day-to-day operations into a system that makes sense.', items: ['Device & endpoint management', 'Microsoft 365 & Google Workspace', 'User access & technical support'] },
  { id: 'security', title: 'Security & continuity', line: 'Prepare for the unexpected.', description: 'Understand where you are exposed, protect what matters, and build a practical plan to keep your business moving when things go wrong.', items: ['Security assessments & hardening', 'Identity & access protection', 'Backup & recovery planning'] },
  { id: 'cloud', title: 'Cloud & infrastructure', line: 'Build on solid ground.', description: 'Connect your people, systems, and data with infrastructure designed around how your business actually works. Clear decisions today. Room to grow tomorrow.', items: ['Cloud planning & migrations', 'Networks & connectivity', 'Infrastructure design & maintenance'] },
  { id: 'automation', title: 'Automation & development', line: 'Make room for better work.', description: 'Turn repetitive tasks and disconnected tools into useful workflows. Purpose-built integrations, internal tools, and websites that solve a real problem.', items: ['Workflow automation', 'Custom integrations & internal tools', 'Web development'] },
]

export const questions = [
  { question: 'What kinds of businesses do you work with?', answer: 'Growing businesses that need dependable technology and a clear direction. We start by understanding your team, existing systems, and priorities to see where Monolith can help.' },
  { question: 'Can you work with our existing IT team?', answer: 'Yes. We can support an internal team with a defined project, specialist work, or ongoing help. Responsibilities and scope are agreed together before work begins.' },
  { question: 'Do you offer projects as well as ongoing support?', answer: 'Yes. Whether you need a migration, a new workflow, or a longer-term technology partner, we shape the engagement around the work you actually need.' },
  { question: 'What happens after I get in touch?', answer: 'We review your inquiry and follow up to discuss your situation. From there, we agree on priorities, scope, and next steps before any work begins.' },
]
