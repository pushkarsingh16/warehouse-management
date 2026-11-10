import { useEffect, useRef, useId, cloneElement } from 'react';
import { X, ArrowUpRight, LoaderCircle, Inbox, AlertCircle, ChevronRight } from 'lucide-react';
export function Button({ children, kind = 'secondary', busy, className = '', ...props }) { return <button {...props} className={`button ${kind} ${className}`} disabled={props.disabled || busy}>{busy && <LoaderCircle size={15} className="spin"/>}{children}</button>; }
export function Badge({ children, tone = 'neutral' }) { return <span className={`badge ${tone}`}><i/>{children}</span>; }
export function Status({ value }) { const tone = ['DISPATCHED', 'COMPLETED', 'SUCCEEDED', 'COVERED', 'CURRENT', 'PICKED'].includes(value) ? 'green' : ['FAILED', 'SHORTFALL', 'ACTIVE'].includes(value) ? 'red' : ['RESERVED', 'PICKING', 'CLAIMED', 'PARTIAL', 'STALE', 'RUNNING'].includes(value) ? 'amber' : 'neutral'; return <Badge tone={tone}>{(value || 'Unavailable').replaceAll('_', ' ').toLowerCase()}</Badge>; }
export function Empty({ title = 'Nothing here yet', children }) { return <div className="empty"><Inbox size={30}/><h3>{title}</h3><p>{children || 'New activity will appear here automatically.'}</p></div>; }
export function ErrorBox({ error, retry }) { if (!error) return null; return <div role="alert" className="error"><AlertCircle size={17}/><span>{error.message || error}</span>{retry && <button onClick={retry}>Retry</button>}</div>; }
export function Loading({ text = 'Loading workspace…' }) { return <div className="loading" role="status"><LoaderCircle className="spin" size={22}/>{text}</div>; }
export function PanelTitle({ eyebrow, title, children }) { return <div className="panel-title"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{children}</div>; }
export function Stat({ label, value, detail, icon: Icon, tone = '' }) { return <div className={`stat ${tone}`}><div className="stat-top"><span>{label}</span><Icon size={18}/></div><strong>{value}</strong><div className="stat-detail">{detail}</div></div>; }
export function Modal({ title, children, close }) {
  const ref = useRef();
  useEffect(() => { const prior = document.activeElement; const dialog = ref.current; dialog.showModal(); return () => { dialog.close(); prior?.focus(); }; }, []);
  return <dialog ref={ref} className="modal" onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={20}/></button></div>{children}</dialog>;
}
export function Field({ label, children, hint }) { const id = useId(); return <label className="field"><span id={id}>{label}</span>{cloneElement(children, { ...(children.props['aria-label'] ? {} : { 'aria-labelledby': id }), ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) })}{hint && <small id={`${id}-hint`}>{hint}</small>}</label>; }
export const shortId = id => id ? `#${id.slice(-7).toUpperCase()}` : '—';
export const number = value => Number.isFinite(value) ? new Intl.NumberFormat('en').format(Math.round(value * 10) / 10) : '—';
export const dateTime = value => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export function LinkButton({ children, onClick }) { return <button className="text-button" onClick={onClick}>{children}<ArrowUpRight size={15}/></button>; }
export function Table({ headers, children }) { return <div className="table-scroll"><table><thead><tr>{headers.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
export function DetailRow({ label, children }) { return <div className="detail-row"><span>{label}</span><strong>{children}</strong></div>; }
