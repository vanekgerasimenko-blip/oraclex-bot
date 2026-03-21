// api-client.js
// ════════════════════════════════════════
//  ПУНКТ 5: Клієнт для Mini App
//
//  Вставити цей код в oraclex-final.html
//  ЗАМІСТЬ localStorage логіки.
//
//  Підключення до API сервера:
//  1. Авторизація через Telegram
//  2. Завантаження ринків з сервера (пагінація)
//  3. Синхронізація балансу
//  4. Ставки через API
// ════════════════════════════════════════

const OracleAPI = (() => {

  // ── Конфіг ─────────────────────────────
  const API_URL = 'https://твій-railway-url.railway.app'; // ← змінити на реальний URL
  let TOKEN     = null;
  let USER      = null;

  // ── Базовий запит ───────────────────────
  async function request(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

    try {
      const res = await fetch(`${API_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const data = await res.json();

      if (!res.ok) {
        console.warn(`API ${method} ${path} → ${res.status}:`, data.error);
        return { error: data.error || 'request_failed', status: res.status };
      }

      return data;
    } catch (err) {
      console.error(`API error ${path}:`, err.message);
      return { error: 'network_error' };
    }
  }

  // ════ ПУНКТ 3: АВТОРИЗАЦІЯ ════

  /**
   * Авторизуємось через Telegram initData
   * Викликати при старті Mini App
   */
  async function auth() {
    const TG       = window.Telegram?.WebApp;
    const initData = TG?.initData;

    // В браузері (без Telegram) — тестовий режим
    if (!initData) {
      console.warn('⚠️ Telegram не знайдено — тестовий режим');
      TOKEN = localStorage.getItem('oraclex_token');
      if (TOKEN) {
        USER = await getMe();
        return USER;
      }
      return null;
    }

    // Відправляємо initData на сервер для верифікації
    const result = await request('POST', '/api/auth/telegram', { initData });

    if (result.error) {
      console.error('Auth failed:', result.error);
      return null;
    }

    // Зберігаємо токен
    TOKEN = result.token;
    USER  = result.user;
    localStorage.setItem('oraclex_token', TOKEN);

    console.log(`✅ Авторизовано: ${USER.username} (${USER.gems} 💎)`);
    return USER;
  }

  // ════ ПУНКТ 4: РИНКИ З ПАГІНАЦІЄЮ ════

  let marketsPage    = 0;
  let marketsHasMore = true;
  let marketsLoading = false;

  /**
   * Завантажити ринки (перша сторінка)
   */
  async function loadMarkets(room = 'all', reset = true) {
    if (reset) {
      marketsPage    = 0;
      marketsHasMore = true;
    }
    if (!marketsHasMore || marketsLoading) return [];

    marketsLoading = true;
    const data = await request('GET', `/api/markets?page=${marketsPage}&limit=20&room=${room}`);
    marketsLoading = false;

    if (data.error) return [];

    marketsPage++;
    marketsHasMore = data.pagination.hasMore;

    return data.markets;
  }

  /**
   * Завантажити наступну сторінку (infinite scroll)
   */
  async function loadMoreMarkets(room = 'all') {
    return loadMarkets(room, false);
  }

  /**
   * Один ринок
   */
  async function getMarket(id) {
    return request('GET', `/api/markets/${id}`);
  }

  // ════ СТАВКИ ════

  /**
   * Зробити ставку
   */
  async function placeBet(marketId, side, amount) {
    return request('POST', '/api/bets', { marketId, side, amount });
  }

  /**
   * Мої ставки
   */
  async function getMyBets(page = 0) {
    return request('GET', `/api/bets/my?page=${page}`);
  }

  // ════ ПУНКТ 5: СИНХРОНІЗАЦІЯ БАЛАНСУ ════

  /**
   * Отримати актуальний баланс з сервера
   */
  async function getMe() {
    const data = await request('GET', '/api/users/me');
    if (!data.error) {
      USER = data;
      // Оновлюємо локальний стан
      if (typeof gems !== 'undefined') gems = data.gems;
      if (typeof STATE !== 'undefined') STATE.gems = data.gems;
    }
    return data;
  }

  /**
   * Синхронізувати локальний стан з сервером
   * Викликати при змінах pathStep, streak, dailyClaimedAt
   */
  async function syncState(fields) {
    const result = await request('POST', '/api/users/me/sync', fields);
    if (!result.error && result.gems !== undefined) {
      // Сервер повертає актуальний баланс
      if (typeof STATE !== 'undefined') STATE.gems = result.gems;
      if (typeof gems  !== 'undefined') gems = result.gems;
    }
    return result;
  }

  /**
   * Щоденна нагорода через сервер
   */
  async function claimDailyServer() {
    const result = await request('POST', '/api/users/daily');
    if (!result.error) {
      if (typeof STATE !== 'undefined') STATE.gems = result.gems;
      if (typeof gems  !== 'undefined') gems = result.gems;
    }
    return result;
  }

  /**
   * Лідерборд
   */
  async function getLeaderboard(limit = 10) {
    return request('GET', `/api/users/leaderboard?limit=${limit}`);
  }

  /**
   * Health check
   */
  async function health() {
    return request('GET', '/api/health');
  }

  // ── Публічний інтерфейс ─────────────────
  return {
    auth,
    loadMarkets, loadMoreMarkets, getMarket,
    placeBet, getMyBets,
    getMe, syncState, claimDailyServer,
    getLeaderboard, health,
    getUser: () => USER,
    getToken: () => TOKEN,
    isAuth: () => !!TOKEN,
  };

})();

// ════════════════════════════════════════
//  ЯК ВИКОРИСТОВУВАТИ в oraclex-final.html
// ════════════════════════════════════════
//
// 1. ІНІЦІАЛІЗАЦІЯ (замість init в кінці файлу):
//
//    async function initApp() {
//      // Авторизуємось
//      const user = await OracleAPI.auth();
//      if (user) {
//        gems   = user.gems;
//        streak = user.streak;
//        games  = user.totalBets;
//      }
//      // Завантажуємо ринки з сервера
//      const markets = await OracleAPI.loadMarkets();
//      markets.forEach(m => {
//        D.push(m);
//        marketMap[m.id] = m;
//      });
//      renderFeed();
//      renderHCards();
//    }
//    initApp();
//
// 2. СТАВКА (замість placeBet):
//
//    async function feedVote(id, side, btn) {
//      const result = await OracleAPI.placeBet(id, side, selectedBet);
//      if (result.error) {
//        toast(result.message || 'Помилка ставки', true);
//        return;
//      }
//      gems = result.user.gems; // актуальний баланс з сервера
//      updBal();
//    }
//
// 3. ЩОДЕННА НАГОРОДА (замість claimDaily):
//
//    async function claimDaily() {
//      const result = await OracleAPI.claimDailyServer();
//      if (result.error === 'already_claimed') {
//        toast(`⏰ Вже отримано. Наступна через ${Math.ceil(result.msLeft/3600000)}г`, true);
//        return;
//      }
//      gems = result.gems;
//      updBal();
//      toast(`🎁 +${result.reward} 💎 · Серія ${result.streak} 🔥`);
//    }
//
// 4. ПАГІНАЦІЯ (infinite scroll в стрічці):
//
//    feedScroll.addEventListener('scroll', async () => {
//      const { scrollTop, scrollHeight, clientHeight } = feedScroll;
//      if (scrollHeight - scrollTop - clientHeight < 200) {
//        const more = await OracleAPI.loadMoreMarkets();
//        more.forEach(m => {
//          D.push(m);
//          marketMap[m.id] = m;
//          feedScroll.appendChild(makeFeedCard(m, cardHeight));
//        });
//      }
//    });
//
