// public/i18n.js
//
// Text-level language switcher for the whole app (English / Русский /
// العربية). This is intentionally a PRESENTATION-ONLY layer:
//   - It never edits app.js, guard.js, or any backend logic.
//   - It never changes DOM structure, ids, classes, or event handlers —
//     it only rewrites the *text* inside text nodes (and a few safe
//     attributes: placeholder/title), so nothing that any existing
//     feature depends on (button ids, click handlers, data-* attrs) is
//     ever touched.
//   - It works on EVERY screen automatically (loading screen, join gate,
//     IP-lock screen, home/spin/task/refer/earning tabs, every modal) via
//     a MutationObserver on #app, so new tabs/modals that get rendered
//     later are translated the same way, with no per-screen wiring.
//   - Unknown/untranslated strings simply stay in English — nothing
//     breaks or shows blank text.
//
// The selected language is remembered in localStorage and re-applied on
// every visit.

(function () {
  const LANG_KEY = "redtube_lang";

  const LANGS = {
    en: { label: "English" },
    ru: { label: "Русский" },
    ar: { label: "العربية" },
  };

  // English phrase -> translation. Keys are matched by TRIMMED exact text,
  // so surrounding whitespace in the original template is preserved.
  const DICT = {
    ru: {
      // Nav
      "Home": "Главная", "Spin": "Спин", "Task": "Задания", "Refer": "Рефералы", "Earning": "Заработок",
      // Header icon tooltips
      "Withdraw history": "История выводов", "Profile": "Профиль", "Language": "Язык",
      // Loading screen
      "LOADING...": "ЗАГРУЗКА...", "Watch Videos": "Смотрите видео", "Earn Rewards": "Зарабатывайте награды",
      "Collect Points": "Собирайте баллы", "Grow Balance": "Увеличивайте баланс", "Real Rewards": "Реальные награды",
      "WATCH": "СМОТРИ", "EARN": "ЗАРАБАТЫВАЙ", "WITHDRAW": "ВЫВОДИ",
      // Join gate
      "One last step to earn": "Ещё один шаг до заработка",
      "Join our official channel & community to unlock REDTUBE.": "Присоединяйтесь к нашему официальному каналу и сообществу, чтобы открыть REDTUBE.",
      "Join Channel": "Вступить в канал", "Join Community": "Вступить в сообщество",
      "✅ I've joined, check now": "✅ Я вступил(а), проверить",
      "You haven't joined both yet. Please join and try again.": "Вы ещё не вступили в оба. Пожалуйста, вступите и попробуйте снова.",
      // Home tab
      "Total Balance": "Общий баланс", "RDC Balance": "Баланс RDC", "USDT Balance": "Баланс USDT",
      "Withdraw": "Вывод", "Convert": "Обменять", "History": "История",
      "Have a promo code?": "Есть промокод?", "Redeem it for free Diamonds & USDT": "Активируйте бесплатные алмазы и USDT",
      "Redeem": "Активировать", "Weekly Contest": "Еженедельный конкурс", "Win exciting rewards": "Выигрывайте крутые награды",
      "Leaderboard": "Таблица лидеров", "Top earners ranking": "Рейтинг лучших",
      "Official Channel": "Официальный канал", "Join community channel": "Вступить в канал сообщества",
      "Pay Channel": "Канал выплат", "Live payment proofs": "Доказательства выплат",
      "Platform stats": "Статистика платформы", "Spins": "Спины", "Tasks": "Задания", "Referrals": "Рефералы",
      "Spin & Win": "Крутить и выигрывать", "Daily": "Ежедневно",
      // Withdraw modal
      "Withdraw USDT": "Вывод USDT", "Select Gateway": "Выберите способ", "MAX": "МАКС",
      "Submit Withdraw": "Отправить заявку", "To address": "На адрес",
      "No withdraw fee — you receive the full amount in USDT (the 25% fee is already taken when you convert RDC to USDT). You must complete at least 5 tasks (lifetime), watch at least 10 ads today, and complete at least 10 spins to withdraw. Once you set your withdraw address it is locked permanently — it cannot be changed later. Requests are reviewed manually within 24 hours.":
        "Без комиссии за вывод — вы получаете полную сумму в USDT (комиссия 25% уже удержана при обмене RDC на USDT). Нужно выполнить не менее 5 заданий (за всё время), посмотреть не менее 10 реклам сегодня и сделать не менее 10 спинов. После установки адреса для вывода он блокируется навсегда — изменить его позже нельзя. Заявки рассматриваются вручную в течение 24 часов.",
      // Converter modal
      "Convert RDC → USDT": "Обмен RDC → USDT",
      "A 25% fee applies here, at conversion — withdrawing afterward is fee-free.": "Здесь взимается комиссия 25% при конвертации — последующий вывод бесплатный.",
      "RDC BALANCE": "БАЛАНС RDC", "Gross value": "Общая сумма", "Fee (25%)": "Комиссия (25%)",
      "You'll receive": "Вы получите", "Enter an amount": "Введите сумму",
      // History modal
      "Withdraw History": "История выводов", "No withdraw requests yet.": "Пока нет заявок на вывод.",
      // Profile modal
      "Total balance": "Общий баланс", "Lifetime earned": "Заработано всего",
      "Tasks completed": "Выполнено заданий", "Close": "Закрыть",
      // Leaderboard
      "Top 20 Referrers": "Топ-20 рефереров", "Ranked by lifetime referrals.": "Рейтинг по рефералам за всё время.",
      "No referrers yet.": "Пока нет рефереров.", "List of participants:": "Список участников:",
      "No participants yet": "Пока нет участников",
      // Weekly contest
      "Weekly Referral Contest": "Еженедельный конкурс рефералов", "Contest ends in:": "Конкурс заканчивается через:",
      "FINISHED": "ЗАВЕРШЕНО", "Your referrals this week": "Ваши рефералы на этой неделе",
      "Share your referral link to be the first on the leaderboard!": "Поделитесь реферальной ссылкой, чтобы стать первым в рейтинге!",
      "THIS WEEK'S TOP REFERRERS": "ЛУЧШИЕ РЕФЕРЕРЫ НЕДЕЛИ", "No referrals yet this week.": "На этой неделе пока нет рефералов.",
      "No previous contest data yet": "Данных о прошлом конкурсе пока нет",
      "Current week": "Текущая неделя", "Previous week": "Прошлая неделя", "Today:": "Сегодня:",
      // Refer tab
      "Refer Friends, Earn RDC": "Приглашайте друзей, зарабатывайте RDC", "Total Referrals": "Всего рефералов",
      "Referral Earnings": "Доход от рефералов", "How Rewards Work": "Как работают награды",
      "Friend completes 10 tasks": "Друг выполняет 10 заданий", "Friend watches 25 ads": "Друг смотрит 25 реклам",
      "Contact support": "Связаться с поддержкой", "Need help instead?": "Нужна помощь?", "YOU": "ВЫ",
      // Spin tab
      "CLAIM REWARD NOW": "ПОЛУЧИТЬ НАГРАДУ", "Tap anywhere to continue": "Нажмите в любом месте, чтобы продолжить",
      "Awesome!": "Отлично!", "You have received": "Вы получили", "You have received a gift": "Вы получили подарок",
      "Gift claimed successfully!": "Подарок успешно получен!", "Claimed": "Получено",
      // Task tab
      "No tasks available yet.": "Пока нет доступных заданий.", "No special tasks available yet.": "Пока нет специальных заданий.",
      "Complete tasks, earn RDC": "Выполняйте задания, зарабатывайте RDC", "Watch ads to earn": "Смотрите рекламу, чтобы заработать",
      "Review your task": "Проверьте своё задание", "Your task is live!": "Ваше задание опубликовано!",
      "My Posted Tasks": "Мои опубликованные задания", "You haven't posted any tasks yet.": "Вы ещё не опубликовали ни одного задания.",
      "Promote your channel, group, bot or website": "Продвигайте канал, группу, бота или сайт",
      "Waiting for payment": "Ожидание оплаты", "Send exactly": "Отправьте точно",
      "Title": "Название", "Price": "Цена", "Type": "Тип", "Link": "Ссылка", "Channel": "Канал",
      "REASON": "ПРИЧИНА", "LIVE": "ОНЛАЙН", "Completions": "Выполнений", "completions": "выполнений",
      // Common / misc
      "Cancel": "Отмена", "Submit": "Отправить", "Congratulations!": "Поздравляем!", "Loading...": "Загрузка...",
      "Loading ad...": "Загрузка рекламы...", "Redeeming...": "Активация...", "REDEEM PROMO CODE": "АКТИВИРОВАТЬ ПРОМОКОД",
      "Could not load eligibility status.": "Не удалось загрузить статус доступности.",
      "Failed to load ads. Pull to refresh.": "Не удалось загрузить рекламу. Потяните, чтобы обновить.",
      "Failed to load contest. Please try again.": "Не удалось загрузить конкурс. Попробуйте снова.",
      "Failed to load referral data. Please try again.": "Не удалось загрузить данные о рефералах. Попробуйте снова.",
      "Please enter a channel/group username first.": "Сначала введите юзернейм канала/группы.",
      "and": "и", "both": "оба", "SOON": "СКОРО",
      // IP-lock / Telegram-only guard screens
      "IP Already In Use": "IP уже используется",
      "This connection is already linked to another account.": "Это подключение уже привязано к другому аккаунту.",
      "Switch your VPN or network, or claim it for this account below.": "Смените VPN или сеть, либо закрепите его за этим аккаунтом ниже.",
      "Please go back to your account.": "Пожалуйста, вернитесь в свой аккаунт.",
      "🔄 I've switched — try again": "🔄 Я переключился — попробовать снова",
      "Switch account (resets my balance)": "Сменить аккаунт (сбросит баланс)",
      "Switching claims this connection for your account but resets your RDC and USDT balance to zero.": "Переключение закрепит это подключение за вашим аккаунтом, но обнулит баланс RDC и USDT.",
      "This will reset your entire balance to zero. Continue?": "Это обнулит весь ваш баланс. Продолжить?",
      "OK": "ОК", "Open in Telegram": "Открыть в Telegram",
      "This app only works inside Telegram. Please open it from the RedTube bot, not a browser link.": "Это приложение работает только внутри Telegram. Откройте его через бота RedTube, а не по ссылке в браузере.",
    },
    ar: {
      // Nav
      "Home": "الرئيسية", "Spin": "السحب", "Task": "المهام", "Refer": "الإحالة", "Earning": "الأرباح",
      // Header icon tooltips
      "Withdraw history": "سجل السحب", "Profile": "الملف الشخصي", "Language": "اللغة",
      // Loading screen
      "LOADING...": "جارٍ التحميل...", "Watch Videos": "شاهد الفيديوهات", "Earn Rewards": "اكسب المكافآت",
      "Collect Points": "اجمع النقاط", "Grow Balance": "زد رصيدك", "Real Rewards": "مكافآت حقيقية",
      "WATCH": "شاهد", "EARN": "اربح", "WITHDRAW": "اسحب",
      // Join gate
      "One last step to earn": "خطوة أخيرة للبدء بالربح",
      "Join our official channel & community to unlock REDTUBE.": "انضم إلى قناتنا الرسمية ومجتمعنا لفتح REDTUBE.",
      "Join Channel": "انضم للقناة", "Join Community": "انضم للمجتمع",
      "✅ I've joined, check now": "✅ لقد انضممت، تحقق الآن",
      "You haven't joined both yet. Please join and try again.": "لم تنضم إلى الاثنين بعد. يرجى الانضمام والمحاولة مرة أخرى.",
      // Home tab
      "Total Balance": "الرصيد الإجمالي", "RDC Balance": "رصيد RDC", "USDT Balance": "رصيد USDT",
      "Withdraw": "سحب", "Convert": "تحويل", "History": "السجل",
      "Have a promo code?": "هل لديك رمز ترويجي؟", "Redeem it for free Diamonds & USDT": "استبدله بألماس و USDT مجانًا",
      "Redeem": "استبدال", "Weekly Contest": "المسابقة الأسبوعية", "Win exciting rewards": "اربح مكافآت مذهلة",
      "Leaderboard": "لوحة المتصدرين", "Top earners ranking": "ترتيب الأعلى ربحًا",
      "Official Channel": "القناة الرسمية", "Join community channel": "انضم إلى قناة المجتمع",
      "Pay Channel": "قناة الدفع", "Live payment proofs": "إثباتات دفع مباشرة",
      "Platform stats": "إحصائيات المنصة", "Spins": "السحبات", "Tasks": "المهام", "Referrals": "الإحالات",
      "Spin & Win": "أدر واربح", "Daily": "يومي",
      // Withdraw modal
      "Withdraw USDT": "سحب USDT", "Select Gateway": "اختر وسيلة الدفع", "MAX": "الحد الأقصى",
      "Submit Withdraw": "إرسال طلب السحب", "To address": "إلى العنوان",
      "No withdraw fee — you receive the full amount in USDT (the 25% fee is already taken when you convert RDC to USDT). You must complete at least 5 tasks (lifetime), watch at least 10 ads today, and complete at least 10 spins to withdraw. Once you set your withdraw address it is locked permanently — it cannot be changed later. Requests are reviewed manually within 24 hours.":
        "لا توجد رسوم سحب — تحصل على المبلغ كاملاً بعملة USDT (تم خصم رسوم 25٪ بالفعل عند تحويل RDC إلى USDT). يجب إكمال 5 مهام على الأقل (مدى الحياة)، ومشاهدة 10 إعلانات على الأقل اليوم، وإتمام 10 سحبات على الأقل. بمجرد تعيين عنوان السحب يتم قفله بشكل دائم — لا يمكن تغييره لاحقًا. تتم مراجعة الطلبات يدويًا خلال 24 ساعة.",
      // Converter modal
      "Convert RDC → USDT": "تحويل RDC → USDT",
      "A 25% fee applies here, at conversion — withdrawing afterward is fee-free.": "يتم تطبيق رسوم 25٪ هنا عند التحويل — السحب لاحقًا بدون رسوم.",
      "RDC BALANCE": "رصيد RDC", "Gross value": "القيمة الإجمالية", "Fee (25%)": "الرسوم (25٪)",
      "You'll receive": "ستحصل على", "Enter an amount": "أدخل مبلغًا",
      // History modal
      "Withdraw History": "سجل السحب", "No withdraw requests yet.": "لا توجد طلبات سحب حتى الآن.",
      // Profile modal
      "Total balance": "الرصيد الإجمالي", "Lifetime earned": "إجمالي الأرباح",
      "Tasks completed": "المهام المكتملة", "Close": "إغلاق",
      // Leaderboard
      "Top 20 Referrers": "أفضل 20 محيلًا", "Ranked by lifetime referrals.": "مرتب حسب إجمالي الإحالات.",
      "No referrers yet.": "لا يوجد محيلون بعد.", "List of participants:": "قائمة المشاركين:",
      "No participants yet": "لا يوجد مشاركون بعد",
      // Weekly contest
      "Weekly Referral Contest": "مسابقة الإحالة الأسبوعية", "Contest ends in:": "تنتهي المسابقة خلال:",
      "FINISHED": "انتهت", "Your referrals this week": "إحالاتك هذا الأسبوع",
      "Share your referral link to be the first on the leaderboard!": "شارك رابط الإحالة الخاص بك لتكون الأول في لوحة المتصدرين!",
      "THIS WEEK'S TOP REFERRERS": "أفضل المحيلين هذا الأسبوع", "No referrals yet this week.": "لا توجد إحالات هذا الأسبوع بعد.",
      "No previous contest data yet": "لا توجد بيانات للمسابقة السابقة بعد",
      "Current week": "الأسبوع الحالي", "Previous week": "الأسبوع السابق", "Today:": "اليوم:",
      // Refer tab
      "Refer Friends, Earn RDC": "أحِل الأصدقاء واربح RDC", "Total Referrals": "إجمالي الإحالات",
      "Referral Earnings": "أرباح الإحالة", "How Rewards Work": "كيف تعمل المكافآت",
      "Friend completes 10 tasks": "يكمل صديقك 10 مهام", "Friend watches 25 ads": "يشاهد صديقك 25 إعلانًا",
      "Contact support": "تواصل مع الدعم", "Need help instead?": "هل تحتاج إلى مساعدة؟", "YOU": "أنت",
      // Spin tab
      "CLAIM REWARD NOW": "احصل على المكافأة الآن", "Tap anywhere to continue": "اضغط في أي مكان للمتابعة",
      "Awesome!": "رائع!", "You have received": "لقد حصلت على", "You have received a gift": "لقد حصلت على هدية",
      "Gift claimed successfully!": "تم استلام الهدية بنجاح!", "Claimed": "تم الاستلام",
      // Task tab
      "No tasks available yet.": "لا توجد مهام متاحة حتى الآن.", "No special tasks available yet.": "لا توجد مهام خاصة متاحة حتى الآن.",
      "Complete tasks, earn RDC": "أكمل المهام واربح RDC", "Watch ads to earn": "شاهد الإعلانات لتربح",
      "Review your task": "راجع مهمتك", "Your task is live!": "مهمتك أصبحت مباشرة الآن!",
      "My Posted Tasks": "مهامي المنشورة", "You haven't posted any tasks yet.": "لم تنشر أي مهام بعد.",
      "Promote your channel, group, bot or website": "روّج لقناتك أو مجموعتك أو بوتك أو موقعك",
      "Waiting for payment": "في انتظار الدفع", "Send exactly": "أرسل بالضبط",
      "Title": "العنوان", "Price": "السعر", "Type": "النوع", "Link": "الرابط", "Channel": "القناة",
      "REASON": "السبب", "LIVE": "مباشر", "Completions": "مرات الإكمال", "completions": "مرات إكمال",
      // Common / misc
      "Cancel": "إلغاء", "Submit": "إرسال", "Congratulations!": "تهانينا!", "Loading...": "جارٍ التحميل...",
      "Loading ad...": "جارٍ تحميل الإعلان...", "Redeeming...": "جارٍ الاستبدال...", "REDEEM PROMO CODE": "استبدال الرمز الترويجي",
      "Could not load eligibility status.": "تعذر تحميل حالة الأهلية.",
      "Failed to load ads. Pull to refresh.": "فشل تحميل الإعلانات. اسحب للتحديث.",
      "Failed to load contest. Please try again.": "فشل تحميل المسابقة. حاول مرة أخرى.",
      "Failed to load referral data. Please try again.": "فشل تحميل بيانات الإحالة. حاول مرة أخرى.",
      "Please enter a channel/group username first.": "يرجى إدخال اسم مستخدم القناة/المجموعة أولاً.",
      "and": "و", "both": "كلاهما", "SOON": "قريبًا",
      // IP-lock / Telegram-only guard screens
      "IP Already In Use": "عنوان IP مستخدم بالفعل",
      "This connection is already linked to another account.": "هذا الاتصال مرتبط بالفعل بحساب آخر.",
      "Switch your VPN or network, or claim it for this account below.": "قم بتبديل VPN أو الشبكة، أو اطلبه لهذا الحساب أدناه.",
      "Please go back to your account.": "يرجى العودة إلى حسابك.",
      "🔄 I've switched — try again": "🔄 لقد قمت بالتبديل — حاول مرة أخرى",
      "Switch account (resets my balance)": "تبديل الحساب (سيعيد تعيين رصيدي)",
      "Switching claims this connection for your account but resets your RDC and USDT balance to zero.": "التبديل يربط هذا الاتصال بحسابك لكنه يعيد تعيين رصيد RDC و USDT إلى صفر.",
      "This will reset your entire balance to zero. Continue?": "سيؤدي هذا إلى إعادة تعيين رصيدك بالكامل إلى صفر. متابعة؟",
      "OK": "موافق", "Open in Telegram": "افتح في تيليجرام",
      "This app only works inside Telegram. Please open it from the RedTube bot, not a browser link.": "يعمل هذا التطبيق فقط داخل تيليجرام. يرجى فتحه من بوت RedTube، وليس عبر رابط المتصفح.",
    },
  };

  function getLang() {
    const v = localStorage.getItem(LANG_KEY);
    return LANGS[v] ? v : "en";
  }

  function setLang(lang) {
    if (!LANGS[lang]) return;
    localStorage.setItem(LANG_KEY, lang);
    updateSwitcherUI();
    applyAll();
  }

  function translateString(str) {
    const lang = getLang();
    if (lang === "en") return str;
    const dict = DICT[lang];
    if (!dict) return str;
    const trimmed = str.trim();
    if (!trimmed) return str;
    const hit = dict[trimmed];
    if (!hit) return str;
    if (trimmed === str) return hit;
    // preserve original surrounding whitespace (template strings often
    // leave a trailing space before an inline icon/span)
    const idx = str.indexOf(trimmed);
    if (idx === -1) return str;
    return str.slice(0, idx) + hit + str.slice(idx + trimmed.length);
  }

  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1 };

  function walk(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const translated = translateString(node.nodeValue);
      if (translated !== node.nodeValue) node.nodeValue = translated;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (SKIP_TAGS[node.tagName]) return;
    if (node.id === "langSwitchMenu") return; // language names themselves stay native
    if (node.hasAttribute) {
      if (node.hasAttribute("placeholder")) {
        const tr = translateString(node.getAttribute("placeholder"));
        if (tr !== node.getAttribute("placeholder")) node.setAttribute("placeholder", tr);
      }
      if (node.hasAttribute("title") && node.id !== "langSwitchBtn") {
        const tr = translateString(node.getAttribute("title"));
        if (tr !== node.getAttribute("title")) node.setAttribute("title", tr);
      }
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  }

  function applyAll() {
    walk(document.getElementById("app"));
    walk(document.getElementById("telegramOnlyScreen"));
  }

  function updateSwitcherUI() {
    const lang = getLang();
    const labelEl = document.getElementById("langSwitchLabel");
    if (labelEl) labelEl.textContent = LANGS[lang].label;
    document.querySelectorAll(".lang-switch-option").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lang === lang);
    });
  }

  let observerBusy = false;
  function startObserver() {
    const target = document.getElementById("app") || document.body;
    const observer = new MutationObserver((mutations) => {
      if (getLang() === "en" || observerBusy) return;
      observerBusy = true;
      for (const m of mutations) {
        m.addedNodes && m.addedNodes.forEach((n) => walk(n));
        if (m.type === "characterData") walk(m.target);
      }
      observerBusy = false;
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true });
  }

  function wireSwitcher() {
    const wrap = document.getElementById("langSwitch");
    const btn = document.getElementById("langSwitchBtn");
    const menu = document.getElementById("langSwitchMenu");
    if (!wrap || !btn || !menu) return;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      wrap.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) wrap.classList.remove("open");
    });
    menu.querySelectorAll(".lang-switch-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        setLang(opt.dataset.lang);
        wrap.classList.remove("open");
      });
    });
  }

  function init() {
    wireSwitcher();
    updateSwitcherUI();
    startObserver();
    applyAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
