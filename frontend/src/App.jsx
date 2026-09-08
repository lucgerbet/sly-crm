import { useCallback, useState } from 'react';
import Dashboard from './components/Dashboard.jsx';
import ClientList from './components/ClientList.jsx';
import ClientDetail from './components/ClientDetail.jsx';
import Daily from './components/Daily.jsx';
import Orders from './components/Orders.jsx';
import Reports from './components/Reports.jsx';
import Automation from './components/Automation.jsx';
import Analytics from './components/Analytics.jsx';
import SizeChart from './components/SizeChart.jsx';
import Products from './components/Products.jsx';
import Content from './components/Content.jsx';

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'daily',     label: 'My Day'    },
  { id: 'clients',   label: 'Clients'   },
  { id: 'prospects', label: 'Prospects' },
  { id: 'orders',    label: 'Orders'    },
  { id: 'reports',   label: 'Reports'   },
  { id: 'analytics', label: 'Analytics' },
  { id: 'products',  label: 'Produits'  },
  { id: 'sizes',     label: 'Size chart' },
  { id: 'content',   label: 'Contenu'   },
  { id: 'automation', label: 'Automation' },
];

// The stylist tool — a separate app on its own subdomain, behind the same
// Basic Auth. Linked rather than embedded: it is where an order is actually
// taken, and Luc reaches for it from the CRM several times a day.
const STYLIST_URL = 'https://sly-styliste.srv1758374.hstgr.cloud/';

let toastId = 0;

export default function App() {
  const [view, setView] = useState('dashboard');
  const [toasts, setToasts] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [clientFilters, setClientFilters] = useState({});
  const [refreshSpin, setRefreshSpin] = useState(false);

  const notify = useCallback((message, type = 'info') => {
    const id = ++toastId;
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500);
  }, []);

  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);

  function handleManualRefresh() {
    refresh();
    setRefreshSpin(true);
    setTimeout(() => setRefreshSpin(false), 600);
  }

  function openPanel(id) {
    setSelectedId(id || null);
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
    setSelectedId(null);
  }

  function goTo(tab, filters = {}) {
    if (tab === 'clients') {
      const { openId, ...rest } = filters;
      setClientFilters(rest);
      setView('clients');
      if (openId) setTimeout(() => openPanel(openId), 50);
    } else {
      setView(tab);
    }
  }

  return (
    <div className="min-h-screen bg-bg text-ink-primary">
      <header className="sticky top-0 z-20 bg-bg/95 backdrop-blur border-b border-line">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-8 h-8 rounded-md bg-accent text-white flex items-center justify-center font-medium text-xs tracking-wider">
              SLY
            </div>
            <div className="leading-tight">
              <div className="text-sm font-medium">SLY</div>
              <div className="text-[10px] text-ink-secondary uppercase tracking-[0.12em]">CRM</div>
            </div>
          </div>
          {/* min-w-0 + overflow : au onzième onglet, la barre débordait sur le
              logo et les libellés en deux mots passaient à la ligne. Elle
              défile maintenant au lieu de se replier, quel que soit le nombre
              d'onglets et la largeur d'écran. */}
          <div className="flex items-center gap-2 min-w-0">
            <nav className="flex items-center gap-0.5 overflow-x-auto no-scrollbar min-w-0">
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setView(tab.id)}
                  className={`px-3 py-1.5 rounded-md text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                    view === tab.id ? 'bg-accent text-white' : 'text-ink-secondary hover:text-ink-primary'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
            <a
              href={STYLIST_URL}
              target="_blank"
              rel="noreferrer"
              title="Ouvre l'outil de prise de commande dans un nouvel onglet"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium border border-line text-ink-secondary hover:text-ink-primary hover:border-ink-secondary transition-colors whitespace-nowrap shrink-0"
            >
              Prise de commande
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
                <path d="M7 17 17 7M9 7h8v8" />
              </svg>
            </a>

            <button
              onClick={handleManualRefresh}
              title="Refresh"
              className="w-8 h-8 shrink-0 flex items-center justify-center rounded-md text-ink-secondary hover:text-ink-primary hover:bg-line/50 transition-colors"
            >
              <svg
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"
                className={refreshSpin ? 'animate-spin' : ''}
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {view === 'dashboard' && <Dashboard key={`dash-${refreshKey}`} goTo={goTo} />}
        {view === 'products' && <Products key={`products-${refreshKey}`} notify={notify} />}
        {view === 'sizes' && <SizeChart key={`sizes-${refreshKey}`} notify={notify} />}
        {view === 'daily' && (
          <Daily key={`daily-${refreshKey}`} notify={notify} onSelect={id => openPanel(id)} onChanged={refresh} />
        )}
        {view === 'prospects' && (
          <ClientList
            key={`prospects-${refreshKey}`}
            mode="prospects"
            onSelect={id => openPanel(id)}
            onNew={() => openPanel(null)}
            notify={notify}
          />
        )}
        {view === 'clients' && (
          <ClientList
            key={`list-${refreshKey}`}
            initialFilters={clientFilters}
            onSelect={id => openPanel(id)}
            onNew={() => openPanel(null)}
            notify={notify}
          />
        )}
        {view === 'orders' && (
          <Orders key={`orders-${refreshKey}`} notify={notify} onSelectClient={id => openPanel(id)} />
        )}
        {view === 'reports' && <Reports key={`rep-${refreshKey}`} />}
        {view === 'analytics' && <Analytics key={`analytics-${refreshKey}`} />}
        {view === 'content' && <Content key={`content-${refreshKey}`} notify={notify} />}
        {view === 'automation' && <Automation key={`auto-${refreshKey}`} notify={notify} />}
      </main>

      {panelOpen && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px]" onClick={closePanel} />
          <div className="fixed right-0 top-0 bottom-0 z-40 w-[640px] max-w-full bg-surface shadow-2xl flex flex-col">
            <ClientDetail
              clientId={selectedId}
              onClose={closePanel}
              onSaved={() => { closePanel(); refresh(); }}
              onDeleted={() => { closePanel(); refresh(); }}
              onChanged={refresh}
              notify={notify}
            />
          </div>
        </>
      )}

      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 w-80">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`bg-surface border rounded-lg py-3 px-4 shadow-lg text-sm flex items-start gap-2 ${
              t.type === 'error' ? 'border-red-200' : t.type === 'success' ? 'border-green-200' : 'border-line'
            }`}
          >
            <span
              className="mt-1.5 w-2 h-2 rounded-full shrink-0"
              style={{ background: t.type === 'error' ? '#E24B4A' : t.type === 'success' ? '#1D9E75' : '#9CA3AF' }}
            />
            <span className="leading-snug">{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
