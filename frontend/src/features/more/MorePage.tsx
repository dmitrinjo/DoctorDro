import { Outlet, useNavigate, Navigate, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  IconSearch,
  IconMessageChatbot,
  IconStethoscope,
  IconPill,
  IconVaccine,
  IconRuler2,
  IconTestPipe,
  IconBell,
  IconFileExport,
  IconMenu2,
  IconTopologyStar3,
  IconChevronRight,
  IconHistory,
  IconShieldLock,
  IconLogout,
} from '@tabler/icons-react';
import { PageContainer } from '@/shared/layout/PageContainer';
import { PatientCard } from '@/features/dashboard/components/PatientCard';
import { useDashboard } from '@/features/dashboard/hooks/useDashboard';
import { qk } from '@/shared/api/keys';
import { fetchVersion } from './api';
import { haptic } from '@/shared/lib/haptic';
import { getSession } from '@/shared/auth/session';
import { useAuth } from '@/shared/auth/AuthContext';
import { useIsDesktop } from '@/shared/hooks/useMediaQuery';

/**
 * Главная страница раздела «Ещё» — меню со всеми подразделами.
 * Все подэкраны открываются как route-based модалки (URL /more/<name>).
 */

interface MenuItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  iconBg: string;
  action: 'navigate' | 'route' | 'export';
  target: string;
}

const MENU: MenuItem[] = [
  { id: 'search', label: 'Поиск', icon: IconSearch, iconBg: 'var(--purple)', action: 'route', target: '/more/search' },
  { id: 'ai-chat', label: 'Чат с AI', icon: IconMessageChatbot, iconBg: 'linear-gradient(135deg,#007AFF,#5AC8FA)', action: 'route', target: '/more/ai-chat' },
  { id: 'specialists', label: 'Специалисты', icon: IconStethoscope, iconBg: 'var(--blue)', action: 'route', target: '/more/specialists' },
  { id: 'medications', label: 'Все препараты', icon: IconPill, iconBg: 'var(--green)', action: 'route', target: '/more/medications' },
  { id: 'vaccinations', label: 'Прививки', icon: IconVaccine, iconBg: '#5AC8FA', action: 'route', target: '/more/vaccinations' },
  { id: 'growth', label: 'Рост и вес', icon: IconRuler2, iconBg: '#FF9500', action: 'route', target: '/more/growth' },
  { id: 'labs', label: 'Анализы', icon: IconTestPipe, iconBg: '#FF3B30', action: 'route', target: '/more/labs' },
  { id: 'reminders', label: 'Напоминания', icon: IconBell, iconBg: 'var(--orange)', action: 'route', target: '/more/reminders' },
  { id: 'export', label: 'Экспорт отчёта', icon: IconFileExport, iconBg: 'var(--red)', action: 'export', target: '' },
  { id: 'diagnoses', label: 'Диагнозы', icon: IconStethoscope, iconBg: 'var(--red)', action: 'navigate', target: '/diagnoses' },
  { id: 'graph', label: 'Карта здоровья', icon: IconTopologyStar3, iconBg: 'linear-gradient(135deg,#AF52DE,#007AFF)', action: 'navigate', target: '/graph' },
  { id: 'history', label: 'История изменений', icon: IconHistory, iconBg: 'var(--blue)', action: 'route', target: '/more/history' },
  { id: 'security', label: 'Безопасность', icon: IconShieldLock, iconBg: 'linear-gradient(135deg,#FF3B30,#FF9500)', action: 'route', target: '/more/security' },
];

export function MorePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const { logout } = useAuth();
  const { data: dashboard } = useDashboard();
  const { data: version } = useQuery({ queryKey: qk.version, queryFn: fetchVersion, retry: false });

  // На десктопе раздел «Ещё» не нужен — всё уже в sidebar.
  if (isDesktop) {
    // Корневой /more → редирект на dashboard
    if (location.pathname === '/more') {
      return <Navigate to="/dashboard" replace />;
    }
    // Вложенные /more/* — рендерим ТОЛЬКО Outlet, без menu.
    // Child-модалки (SearchModal, SpecialistsModal и т.д.) сами решают
    // как отрисоваться на десктопе (desktopStyle="page" в Modal props).
    return <Outlet />;
  }

  const handleClick = (item: MenuItem) => {
    haptic('light');
    if (item.action === 'export') {
      const session = getSession();
      const token = session.sessionToken ?? '';
      const pid = session.patientId ?? 1;
      window.open(`/api/export/pdf?token=${encodeURIComponent(token)}&patient_id=${pid}`, '_blank');
      return;
    }
    navigate(item.target);
  };

  return (
    <PageContainer>
      {dashboard?.patient && <PatientCard patient={dashboard.patient} />}

      <div className="section-subtitle">
        <IconMenu2 size={14} style={{ marginRight: 4 }} /> Разделы
      </div>

      <div className="list-group">
        {MENU.map((item) => {
          const IconComp = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className="list-item"
              onClick={() => handleClick(item)}
              style={{
                width: '100%',
                background: 'var(--card)',
                border: 'none',
                fontFamily: 'inherit',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                textAlign: 'left',
              }}
            >
              <div className="list-item-icon" style={{ background: item.iconBg }}>
                <IconComp size={16} style={{ color: '#fff' }} />
              </div>
              <span className="list-item-text">{item.label}</span>
              <IconChevronRight
                className="list-item-chevron"
                size={16}
                style={{ color: 'var(--text-secondary)' }}
              />
            </button>
          );
        })}
      </div>

      <div className="list-group" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="list-item"
          onClick={() => { haptic('light'); void logout(); }}
          style={{
            width: '100%',
            background: 'var(--card)',
            border: 'none',
            fontFamily: 'inherit',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            textAlign: 'left',
          }}
        >
          <div className="list-item-icon" style={{ background: 'var(--red)' }}>
            <IconLogout size={16} style={{ color: '#fff' }} />
          </div>
          <span className="list-item-text" style={{ color: 'var(--red)' }}>Выйти</span>
        </button>
      </div>

      {version && (
        <div
          style={{
            textAlign: 'center',
            fontSize: 12,
            color: 'var(--text-secondary)',
            marginTop: 20,
          }}
        >
          Версия {version.version}
        </div>
      )}

      <Outlet />
    </PageContainer>
  );
}
