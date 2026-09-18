import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react'
import { questions, services, site } from './siteContent'
import './App.css'

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={diagonal ? 'M6 18 18 6M6 6h12v12' : 'M4 12h15m-6-6 6 6-6 6'} stroke="currentColor" strokeWidth="1.5" /></svg>
}
function Mark() {
  return <svg className="brand-mark" width="28" height="28" viewBox="0 0 28 28" fill="currentColor" aria-hidden="true"><path d="M2 9 8 6v20H2V9ZM11 4l6-3v25h-6V4ZM20 11l6-3v18h-6V11Z" /></svg>
}
function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion()
  return <motion.div className={className} initial={reduce ? false : { opacity: 0, y: 26 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.12 }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}>{children}</motion.div>
}

function Header() {
  const [open, setOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) { setOpen(false); menuButtonRef.current?.focus() } }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  return <header className="site-header"><a className="brand" href="#home" aria-label="Monolith home"><Mark /><span>MONOLITH</span></a><button ref={menuButtonRef} className="menu-toggle" aria-expanded={open} aria-controls="navigation" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Menu'}<span aria-hidden="true">{open ? '−' : '+'}</span></button><nav id="navigation" className={open ? 'navigation is-open' : 'navigation'} aria-label="Main navigation"><a href="#capabilities" onClick={() => setOpen(false)}>Capabilities</a><a href="#approach" onClick={() => setOpen(false)}>Our approach</a><a className="nav-contact" href="#contact" onClick={() => setOpen(false)}>Let’s talk <Arrow diagonal /></a></nav></header>
}

function Hero() {
  const ref = useRef<HTMLElement>(null)
  const reduce = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] })
  const y = useSpring(useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : 160]), { stiffness: 65, damping: 25 })
  return <section id="home" className="hero" ref={ref} aria-labelledby="hero-title"><motion.div className="hero-image" style={{ y }}><img src="/images/monolith-hero.webp" alt="" fetchPriority="high" /></motion.div><div className="hero-shade" /><div className="hero-content page-width"><motion.p className="eyebrow hero-eyebrow" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.15 }}><span className="small-line" /> TECHNOLOGY. WITH INTENTION.</motion.p><motion.h1 id="hero-title" initial={reduce ? false : { opacity: 0, y: 32 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.15, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}>A stronger<br />foundation.<br /><span>For everything next.</span></motion.h1><motion.div initial={reduce ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, delay: 0.65 }}><p className="hero-description">IT consulting, secure infrastructure, and practical automation for growing businesses.</p><div className="hero-actions"><a className="button button-light" href="#contact">Start a conversation <Arrow diagonal /></a><a className="text-link" href="#capabilities">Explore capabilities <Arrow /></a></div></motion.div></div><div className="hero-bottom page-width"><span>Built to support what’s next.</span><a href="#capabilities">Scroll to explore <span aria-hidden="true">↓</span></a></div></section>
}

function Capabilities() {
  const [active, setActive] = useState('managed-it')
  const reduce = useReducedMotion()
  return <section id="capabilities" className="capabilities section-space page-width" aria-labelledby="capabilities-title"><Reveal className="section-intro"><p className="eyebrow">OUR CAPABILITIES</p><h2 id="capabilities-title">Technology that<br />holds it all together.</h2><p>Your tools should work together. Your team should be able to focus. We help you build the foundation that makes both possible.</p><a className="text-link" href="#contact">Find your starting point <Arrow diagonal /></a></Reveal><div className="services">{services.map(service => <Reveal className={`service ${active === service.id ? 'active' : ''}`} key={service.id}><h3><button onClick={() => setActive(active === service.id ? '' : service.id)} aria-expanded={active === service.id} aria-controls={`service-${service.id}`}><span>{service.title}</span><span className="service-plus" aria-hidden="true">{active === service.id ? '−' : '+'}</span></button></h3><AnimatePresence initial={false}>{active === service.id && <motion.div id={`service-${service.id}`} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reduce ? 0 : 0.35 }} className="service-detail"><p className="service-line">{service.line}</p><p>{service.description}</p><ul>{service.items.map(item => <li key={item}>{item}</li>)}</ul><a href="#contact" className="service-link">Let’s talk about it <Arrow diagonal /></a></motion.div>}</AnimatePresence></Reveal>)}</div></section>
}

function Foundation() {
  return <section className="foundation" aria-labelledby="foundation-title"><img src="/images/monolith-stone.webp" alt="Faceted black stone sculpture suspended above a dark reflective surface" loading="lazy" /><div className="foundation-overlay" /><div className="foundation-content page-width"><Reveal><p className="eyebrow">A CLEARER PERSPECTIVE</p><h2 id="foundation-title">One foundation.<br /><span>Fewer moving parts.</span></h2><p>Technology grows complicated. Working with it shouldn’t. Monolith brings the whole picture into focus, connecting everyday needs with long-term decisions.</p><p className="foundation-note">Considered systems. Practical solutions. Lasting value.</p></Reveal></div></section>
}

function Approach() {
  const steps = [
    ['Assess', 'Understand before we build.', 'We listen, look at what you have, and identify what needs attention. Together, we set clear priorities and a scope that fits.'],
    ['Build', 'Make every decision count.', 'We design and implement the right solution, with careful transitions, clear documentation, and your team involved along the way.'],
    ['Maintain', 'Keep the foundation strong.', 'We help maintain and improve the systems we support, so your technology can evolve alongside your business.'],
  ]
  return <section id="approach" className="approach section-space page-width" aria-labelledby="approach-title"><Reveal className="approach-heading"><p className="eyebrow">HOW WE WORK</p><h2 id="approach-title">Clarity first.<br />Progress follows.</h2><p>No unnecessary complexity. Just a considered path from where you are to where you need to be.</p></Reveal><div className="process">{steps.map(([title, line, description], index) => <Reveal className="process-step" key={title}><span className="step-number">0{index + 1}</span><h3>{title}</h3><h4>{line}</h4><p>{description}</p></Reveal>)}</div></section>
}

function FAQ() {
  return <section className="faq section-space page-width" aria-labelledby="faq-title"><Reveal><p className="eyebrow">A FEW ANSWERS</p><h2 id="faq-title">Before we begin.</h2></Reveal><div>{questions.map(item => <details key={item.question}><summary>{item.question}<span aria-hidden="true">+</span></summary><p>{item.answer}</p></details>)}</div></section>
}

type FieldErrors = Partial<Record<'name' | 'email' | 'company' | 'service' | 'message' | 'consent', string>>
function Contact() {
  const [errors, setErrors] = useState<FieldErrors>({})
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const formRef = useRef<HTMLFormElement>(null)
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (status === 'loading') return
    const data = new FormData(e.currentTarget)
    const value = (name: string) => String(data.get(name) || '').trim()
    const payload = { name: value('name'), email: value('email'), company: value('company'), service: value('service'), teamSize: value('teamSize'), message: value('message'), consent: data.get('consent') === 'on', website: value('website') }
    const next: FieldErrors = {}
    if (!payload.name || payload.name.length > 120) next.name = 'Enter your name (up to 120 characters).'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) || payload.email.length > 254) next.email = 'Enter a valid email address.'
    if (!payload.company || payload.company.length > 160) next.company = 'Enter your company name (up to 160 characters).'
    if (![...services.map(s => s.id), 'not-sure'].includes(payload.service)) next.service = 'Choose a service, or select “Not sure yet”.'
    if (payload.message.length < 10 || payload.message.length > 5000) next.message = 'Tell us a little about what you need (10–5,000 characters).'
    if (!payload.consent) next.consent = 'Please agree so we can respond to your inquiry.'
    setErrors(next)
    if (Object.keys(next).length) {
      setStatus('idle')
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    setStatus('loading')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 20000)
    try {
      const result = await fetch(site.inquiryUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal })
      if (result.status !== 201) throw new Error('Inquiry was not saved')
      setStatus('success')
      formRef.current?.reset()
    } catch { setStatus('error') } finally { window.clearTimeout(timeout) }
  }
  function field(name: keyof FieldErrors) { return { 'aria-invalid': !!errors[name], 'aria-describedby': errors[name] ? `${name}-error` : undefined } }
  // aria-hidden keeps the message out of the label's accessible name; aria-describedby still announces it.
  function error(name: keyof FieldErrors) { return errors[name] && <span id={`${name}-error`} className="field-error" aria-hidden="true">{errors[name]}</span> }
  return <section id="contact" className="contact section-space" aria-labelledby="contact-title"><div className="page-width contact-layout"><Reveal className="contact-intro"><p className="eyebrow">LET’S BUILD WHAT’S NEXT</p><h2 id="contact-title">Good technology<br />starts with a<br /><span>conversation.</span></h2><p>Tell us where you are and what you have in mind. We’ll work out the next step together.</p><a className="contact-email" href={`mailto:${site.contactEmail}`}>{site.contactEmail} <Arrow diagonal /></a><div className="contact-brand"><Mark /><span>A stronger foundation.</span></div></Reveal><Reveal><form ref={formRef} onSubmit={submit} noValidate className="contact-form" aria-label="Contact Monolith" aria-busy={status === 'loading'}><div className="form-row"><label>Your name<input name="name" autoComplete="name" maxLength={120} required {...field('name')} />{error('name')}</label><label>Email address<input name="email" type="email" autoComplete="email" maxLength={254} required {...field('email')} />{error('email')}</label></div><div className="form-row"><label>Company<input name="company" autoComplete="organization" maxLength={160} required {...field('company')} />{error('company')}</label><label>Team size <span className="optional">(optional)</span><select name="teamSize" defaultValue=""><option value="">Select team size</option><option value="1-10">1–10 people</option><option value="11-50">11–50 people</option><option value="51-200">51–200 people</option><option value="201+">201+ people</option></select></label></div><label>What can we help with?<select name="service" defaultValue="" required {...field('service')}><option value="" disabled>Select a capability</option>{services.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}<option value="not-sure">Not sure yet</option></select>{error('service')}</label><label>A little about your project<textarea name="message" rows={4} maxLength={5000} placeholder="What’s working, what isn’t, and what would you like to change?" required {...field('message')} />{error('message')}</label><div className="honeypot" aria-hidden="true"><label>Leave this empty<input name="website" tabIndex={-1} autoComplete="off" /></label></div><label className="consent"><input name="consent" type="checkbox" required {...field('consent')} /><span>I agree to Monolith using these details to respond to my inquiry. <a href="/privacy" target="_blank" rel="noopener">Privacy notice<span className="visually-hidden"> (opens in a new tab)</span></a></span></label>{error('consent')}<button type="submit" className="button button-light form-submit" disabled={status === 'loading'}>{status === 'loading' ? 'Sending inquiry…' : status === 'error' ? 'Try sending again' : 'Send inquiry'}<Arrow diagonal /></button><div aria-live="polite" aria-atomic="true">{status === 'success' && <p className="form-notice success">Your inquiry has been received. Thank you for getting in touch.</p>}{status === 'error' && <p className="form-notice error">We couldn’t confirm your inquiry was received. Please try again, or <a href={`mailto:${site.contactEmail}`}>contact us by email</a>.</p>}</div></form></Reveal></div></section>
}

function Footer() {
  return <footer className="footer page-width"><div className="footer-main"><a className="brand" href="#home" aria-label="Monolith home"><Mark /><span>MONOLITH</span></a><p>IT, built on a stronger foundation.</p><a href="#home" className="back-top">Back to top <span aria-hidden="true">↑</span></a></div><div className="footer-bottom"><span>© {new Date().getFullYear()} Monolith</span><a href="/privacy">Privacy notice</a><span>{site.domain}</span></div></footer>
}

export default function App() {
  return <><a className="skip-link" href="#main">Skip to content</a><Header /><main id="main"><Hero /><Capabilities /><Foundation /><Approach /><FAQ /><Contact /></main><Footer /></>
}
