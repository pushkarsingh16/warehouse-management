import { useEffect, useState, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { Activity, ArrowUpRight, Bell, Box, Boxes, ChartNoAxesCombined, ChevronDown, CircleHelp, ClipboardList, Command, LayoutDashboard, LogOut, Menu, Package, Play, Search, Settings2, ShieldCheck, Sparkles, Warehouse as WarehouseIcon, X } from 'lucide-react';
import { api, allProducts, queryClient, refresh, setCsrf, useData } from './api';
import { useUI } from './store';
import { Badge, Button, Empty, ErrorBox, Field, Loading } from './ui';
import { Warehouse } from './Workspace';
import { Inventory, Orders, Picking, Alerts } from './Operations';
import { Assistant, Forecasts, Simulation } from './Intelligence';
const pages = [{ id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'WORKSPACE' }, { id: 'warehouse', label: 'Warehouse', icon: WarehouseIcon }, { id: 'inventory', label: 'Inventory', icon: Boxes }, { id: 'orders', label: 'Orders', icon: Package }, { id: 'picking', label: 'Picking queue', icon: ClipboardList }, { id: 'forecasts', label: 'Forecasts', icon: ChartNoAxesCombined, group: 'INTELLIGENCE' }, { id: 'assistant', label: 'AI assistant', icon: Sparkles }, { id: 'alerts', label: 'Stock alerts', icon: Bell }, { id: 'simulation', label: 'Simulator', icon: Play, group: 'TOOLS' }];
const headings = { overview: ['Every move, in view.', 'Your warehouse, connected. A clear view of today’s operations.'], warehouse: ['Explore your warehouse.', 'Find products, inspect bins, and follow the next picking route.'], inventory: ['Stock, without the guesswork.', 'Live balances, protected reservations, and audited stock updates.'], orders: ['From request to dispatch.', 'Move every order through a reliable fulfillment workflow.'], picking: ['The next move is yours.', 'Claim a task, follow the route, and confirm each picked unit.'], forecasts: ['Stay a step ahead.', 'Demand forecasts and stock coverage, grounded in your history.'], assistant: ['Clarity, on demand.', 'Ask a question. Follow the evidence. Make the next move.'], alerts: ['Know what needs attention.', 'Stock thresholds that stay active until inventory recovers.'], simulation: ['Put the system in motion.', 'Reproducible scenarios. Real workflows. Visible outcomes.'] };
function Brand() { return <div className="brand"><span className="brand-mark"><Box size={24}/></span><strong>Warehouse<span>OS</span></strong></div>; }
function Login({ done }) {
  const [email, setEmail] = useState('admin@warehouse.test'), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  return <main className="login-page"><section className="login-story"><Brand/><div className="login-headline"><span className="eyebrow">A NEW PERSPECTIVE ON OPERATIONS</span><h1>A place for<br/>everything.<br/><em>A view of it all.</em></h1><p>Inventory, fulfillment, and foresight.<br/>One connected warehouse workspace.</p><div className="login-cubes" aria-hidden="true">{Array.from({length:9},(_,i)=><i key={i}/>)}</div></div><div className="login-footer"><span><span className="dot green"/>Built for the next move</span><span>WAREHOUSEOS / 01</span></div></section><section className="login-form-wrap"><div className="login-form"><span className="eyebrow">WELCOME TO YOUR WORKSPACE</span><h2>Good to have you back.</h2><p>Sign in to see what’s moving.</p><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(null); try { const result = await api('/auth/login', { email, password }); setCsrf(result.data.csrf); await queryClient.invalidateQueries({ queryKey: ['me'] }); done(); } catch(e) { setError(e); } finally { setBusy(false); } }}><Field label="Email address"><input name="email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)}/></Field><Field label="Password"><input name="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)}/></Field><ErrorBox error={error}/><Button kind="primary" className="wide" busy={busy}>Enter workspace<ArrowUpRight size={17}/></Button></form><div className="login-tip"><ShieldCheck size={18}/><span>Use your seeded account and configured seed password. Permissions follow your assigned role.</span></div></div><span className="login-fineprint">Your operations. Your authorized workspace.</span></section></main>;
}
function useLive(user) {
  const [status, setStatus] = useState('connecting'), [events, setEvents] = useState([]);
  useEffect(() => {
    if (!user) return; const socket = io({ withCredentials: true, transports: ['websocket'] }); let timer;
    const versions = new Map();
    socket.on('connect', () => { setStatus('connected'); versions.clear(); refresh(); });
    socket.on('disconnect', () => setStatus('reconnecting')); socket.on('connect_error', () => setStatus('reconnecting'));
    for (const topic of ['inventory', 'order', 'pick-task', 'alert', 'analytics', 'forecast']) socket.on(`${topic}.updated`, value => { const key = `${topic}:${value.id}`; if ((versions.get(key) || 0) >= value.version) return; versions.set(key, value.version); setEvents(rows => [{ ...value, key: `${key}:${value.version}`, time: new Date(), label: `${({inventory:'Inventory',order:'Order','pick-task':'Picking task',alert:'Stock alert',analytics:'Analytics',forecast:'Forecast'})[topic]} updated` }, ...rows].slice(0, 20)); if (!timer) timer = setTimeout(() => { timer = null; refresh(); }, 200); });
    const offline = () => { setStatus('reconnecting'); socket.disconnect(); }; const online = () => socket.connect();
    window.addEventListener('offline', offline); window.addEventListener('online', online);
    return () => { clearTimeout(timer); window.removeEventListener('offline', offline); window.removeEventListener('online', online); socket.disconnect(); };
  }, [user?.id]);
  return { status, events };
}
export default function App() {
  const me = useData(['me'], '/auth/me');
  useEffect(() => { const expired = () => { queryClient.clear(); queryClient.setQueryData(['me'], null); }; window.addEventListener('session-expired', expired); return () => window.removeEventListener('session-expired', expired); }, []);
  useEffect(() => { setCsrf(me.data?.data.csrf); }, [me.data]);
  if (me.isPending) return <div className="boot"><Brand/><Loading/></div>;
  if (me.error?.status !== 401 && me.error) return <div className="boot"><Brand/><ErrorBox error={me.error} retry={me.refetch}/></div>;
  if (!me.data?.data) return <Login done={() => me.refetch()}/>;
  return <Workspace user={me.data.data}/>;
}
function Workspace({ user }) {
  const warehouses = useData(['warehouses'], '/warehouses'); const [chosenWarehouse, setWarehouse] = useState(null); const warehouseId = chosenWarehouse || user.warehouseIds[0];
  const live = useLive(user); const { page, navigate, sidebar, setSidebar, assistant, toggleAssistant, selectBin, setProduct } = useUI();
  const snapshot = useData(['snapshot', warehouseId], `/warehouses/${warehouseId}/snapshot`, Boolean(warehouseId));
  const products = useQuery({ queryKey: ['products'], queryFn: allProducts });
  const orders = useData(['orders', warehouseId], `/orders?warehouseId=${warehouseId}&limit=100`, Boolean(warehouseId));
  const tasks = useData(['tasks', warehouseId], `/pick-tasks?warehouseId=${warehouseId}&limit=100`, Boolean(warehouseId));
  const risks = useData(['risks', warehouseId], `/stock-risks?warehouseId=${warehouseId}&limit=100`, Boolean(warehouseId));
  const analytics = useData(['analytics', warehouseId], `/analytics/overview?warehouseId=${warehouseId}`, Boolean(warehouseId));
  const [search, setSearch] = useState(''), [logoutError, setLogoutError] = useState(null);
  const searchRef = useRef();
  useEffect(() => { const key = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus(); } if(e.key === 'Escape') { setSearch(''); setSidebar(false); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  const suggestions = products.data?.filter(p => `${p.sku} ${p.name}`.toLowerCase().includes(search.toLowerCase())).slice(0, 6) || [];
  const title = headings[page] || headings.overview;
  const pending = snapshot.isPending || products.isPending;
  const data = { user, warehouseId, live, snapshot: snapshot.data?.data, products: products.data || [], orders: orders.data?.data || [], tasks: tasks.data?.data || [], risks: risks.data?.data || [], analytics: analytics.data?.data, risksLoaded: Boolean(risks.data) };
  const activeAlerts = data.risks.filter(r => r.lowStock).length;
  const routes = { overview: Warehouse, warehouse: Warehouse, inventory: Inventory, orders: Orders, picking: Picking, forecasts: Forecasts, assistant: Assistant, alerts: Alerts, simulation: Simulation }; const Page = routes[page];
  async function logout() { try { await api('/auth/logout', {}); setCsrf(''); queryClient.clear(); queryClient.setQueryData(['me'], null); } catch(e) { setLogoutError(e); } }
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a>{sidebar && <div className="nav-scrim" onClick={() => setSidebar(false)}/>}
    <aside className={`sidebar ${sidebar ? 'open' : ''}`}><div className="sidebar-brand"><Brand/><button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setSidebar(false)}><X size={19}/></button></div><div className="workspace-chip"><span className="workspace-avatar">W</span><div><strong>Operations workspace</strong><small>Demo environment</small></div><ChevronDown size={14}/></div><nav aria-label="Main navigation">{pages.filter(p => p.id !== 'simulation' || user.role === 'admin').map(p => <div key={p.id}>{p.group && <span className="nav-group">{p.group}</span>}<button className={`nav-item ${page === p.id ? 'active' : ''}`} aria-current={page === p.id ? 'page' : undefined} onClick={() => navigate(p.id)}><p.icon size={18}/><span>{p.label}</span>{p.id === 'alerts' && activeAlerts > 0 ? <b className="nav-count">{activeAlerts}</b> : p.id === 'assistant' ? <span className="nav-ai">AI</span> : null}</button></div>)}</nav><div className="sidebar-bottom"><div className="system-status"><span className={`dot ${live.status === 'connected' ? 'green' : 'amber'}`}/>{live.status === 'connected' ? 'Live connection active' : 'Reconnecting to live updates'}</div><div className="account"><span className="account-avatar">{user.role.slice(0, 1).toUpperCase()}</span><div><strong>{user.role[0].toUpperCase() + user.role.slice(1)}</strong><small>Warehouse team</small></div><button className="icon-button" aria-label="Sign out" onClick={logout}><LogOut size={17}/></button></div></div></aside>
    <div className="app-body"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebar(true)}><Menu size={21}/></button><span className="breadcrumb">Workspace <span>/</span> <strong>{pages.find(p => p.id === page)?.label || 'Overview'}</strong></span></div><div className="global-search"><Search size={16}/><input ref={searchRef} aria-label="Search products" placeholder="Find a product or SKU…" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌘ K</kbd>{search && <div className="search-results">{suggestions.length ? suggestions.map(p => <button key={p._id} onClick={() => { const b = data.snapshot?.balances.find(b => b.productId === p._id); selectBin(b?.binId || null, p._id); setSearch(''); navigate('warehouse'); }}><Package size={17}/><span><strong>{p.sku}</strong><small>{p.name}</small></span><ArrowUpRight size={16}/></button>) : <p>No matching products</p>}</div>}</div><div className="topbar-actions"><button className="notification-button icon-button" aria-label="Open stock alerts" onClick={() => navigate('alerts')}><Bell size={19}/>{activeAlerts > 0 && <i/>}</button><span className="topbar-divider"/><span className="user-dot">{user.role[0].toUpperCase()}</span></div></header>
      <main id="main-content" className="main-content" tabIndex={-1}><div className="page-heading"><div><div className="page-kicker"><span className="dot green"/> OPERATIONS, CONNECTED</div><h1>{title[0]}</h1><p>{title[1]}</p></div><div className="page-heading-actions"><div className="warehouse-select"><WarehouseIcon size={16}/><select aria-label="Selected warehouse" value={warehouseId || ''} onChange={e => { setWarehouse(e.target.value); selectBin(null); }} >{warehouses.data?.data.map(w => <option key={w._id} value={w._id}>{w.name}</option>)}</select></div>{page !== 'assistant' && <Button kind="primary" onClick={toggleAssistant}><Sparkles size={16}/>Ask assistant</Button>}</div></div>
      <ErrorBox error={logoutError || snapshot.error || products.error || orders.error || tasks.error || risks.error || analytics.error} retry={refresh}/>
      {!warehouseId ? <Empty title="No warehouse assigned">Ask an administrator to assign your account to a warehouse.</Empty> : pending ? <Loading/> : data.snapshot ? Page ? <Page data={data} full={page === 'warehouse'}/> : <Empty title="Page not found"><Button onClick={() => navigate('overview')}>Back to overview</Button></Empty> : <Empty title="Warehouse unavailable"/>}
      <footer className="workspace-footer"><span>WarehouseOS <span>·</span> One workspace. Every move.</span><span>UTC reporting <span>·</span> Synthetic demo data</span></footer></main>
    </div>{assistant && data.snapshot && <><div className="drawer-scrim" onClick={toggleAssistant}/><AssistantDialog key={warehouseId} data={data} close={toggleAssistant}/></>}
  </div>;
}

function AssistantDialog({ data, close }) {
  const dialog = useRef();
  useEffect(() => { const prior = document.activeElement; const node = dialog.current; node.showModal(); return () => { node.close(); prior?.focus(); }; }, []);
  return <dialog ref={dialog} className="assistant-drawer" aria-label="Warehouse assistant" onCancel={e => { e.preventDefault(); close(); }}><Assistant data={data} drawer/></dialog>;
}
