import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getSession, setSessionToken, clearSession, type Session } from './session';
import { api } from '@/shared/api/client';
import { EP } from '@/shared/api/endpoints';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Auth Context — React-обёртка над session store.
 *
 * Отвечает за:
 * - Проверку валидности session_token на старте приложения
 * - Обновление состояния после успешного PIN-login
 * - Logout (очистка session + перенаправление на /pin)
 *
 * Используется в RequireAuth, Header (показать имя пользователя), PinScreen.
 */

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  session: Session;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  recheck: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session>(getSession);
  const queryClient = useQueryClient();

  const recheck = useCallback(async () => {
    const current = getSession();
    if (!current.sessionToken) {
      setStatus('unauthenticated');
      setSession(current);
      return;
    }
    try {
      await api.get(EP.authCheck);
      setStatus('authenticated');
      setSession(current);
    } catch {
      clearSession();
      setSession(getSession());
      setStatus('unauthenticated');
    }
  }, []);

  // Проверка сессии при монтировании
  useEffect(() => {
    void recheck();
  }, [recheck]);

  // Глобальный слушатель 401/403 от api/client.ts.
  // Срабатывает когда любой запрос упал с "Требуется авторизация" или
  // "Устройство отозвано владельцем". В этом случае немедленно чистим
  // локальную сессию и переводим в unauthenticated → RequireAuth
  // редиректит на /pin. Это и есть то что выкидывает жену с её телефона
  // после того как муж нажал "удалить устройство" в /more/security.
  useEffect(() => {
    const onUnauthorized = () => {
      clearSession();
      setSession(getSession());
      setStatus('unauthenticated');
      queryClient.clear();
      try {
        localStorage.removeItem('anamnesis-query-cache-v1');
      } catch {
        // ignore
      }
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, [queryClient]);

  const login = useCallback(
    async (token: string) => {
      setSessionToken(token);
      setSession(getSession());
      setStatus('authenticated');
      // После успешного логина нужно инвалидировать все queries которые могли
      // упасть с 401 пока пользователь был на экране PIN. React Query не
      // ретраит 401 ошибки автоматически, поэтому без invalidate они
      // останутся в error state и dashboard/timeline/... будут пустыми.
      // invalidateQueries помечает всё как stale → срабатывает refetch.
      await queryClient.invalidateQueries();
    },
    [queryClient]
  );

  const logout = useCallback(async () => {
    // Отзываем сессию на сервере пока токен ещё в памяти
    try {
      await api.post(EP.authLogout);
    } catch {
      // Игнорируем — если сервер недоступен, всё равно чистим локальное состояние
    }
    clearSession();
    setSession(getSession());
    setStatus('unauthenticated');
    // Очищаем весь кэш React Query — не хотим чтобы следующий пользователь
    // увидел данные предыдущего из persist cache
    queryClient.clear();
    try {
      localStorage.removeItem('anamnesis-query-cache-v1');
    } catch {
      // ignore
    }
  }, [queryClient]);

  return (
    <AuthContext.Provider value={{ status, session, login, logout, recheck }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
