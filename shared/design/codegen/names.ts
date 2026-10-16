// Readable, deterministic identifiers from layer names (docs/design-tool.md §Design to code).
//
// A name is split into words; each word is looked up in a small table of the words designers use
// for interface parts and states («Кнопка» → button, «Основная» → primary, «Наведение» → hover) and
// otherwise transliterated («Зерно» → zerno). The result is joined as PascalCase for components,
// camelCase for props and classes, kebab-case for files and CSS variables. A `NameRegistry` hands out
// each name once per scope (case-insensitively, so files never clash on macOS), adding 2, 3… in the
// order names are claimed, so the same document always gives the same names.

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
};

/** Words of interface design, by normalized Russian form (lower case, «ё» as «е»). Values may hold
 *  two words ("light blue"). Kept small and explicit: a wrong guess is worse than a transliteration. */
// No prototype: a layer named "constructor" or "toString" is a word like any other, not Object's own property.
const WORDS: Record<string, string> = Object.create(null);
const define = (english: string, ...forms: string[]) => {
  for (const form of forms) WORDS[form] = english;
};
// Parts of an interface
define('button', 'кнопка', 'кнопку', 'кнопки', 'кнопок', 'батон');
define('card', 'карточка', 'карточку', 'карточки');
define('heading', 'заголовок', 'заголовка', 'заголовки', 'хедлайн');
define('subheading', 'подзаголовок', 'подзаголовка');
define('icon', 'иконка', 'иконку', 'иконки', 'иконкой', 'значок', 'пиктограмма');
define('input', 'поле', 'поля', 'инпут', 'ввод');
define('text', 'текст', 'текста', 'тексты');
define('label', 'подпись', 'подписи', 'метка', 'лейбл');
define('tag', 'тег', 'тэг', 'ярлык');
define('badge', 'бейдж', 'плашка');
define('link', 'ссылка', 'ссылку', 'ссылки', 'линк');
define('menu', 'меню');
define('nav', 'навигация', 'навигации');
define('header', 'шапка', 'хедер', 'шапки');
define('footer', 'подвал', 'футер');
define('list', 'список', 'списка', 'списки');
define('item', 'пункт', 'элемент', 'айтем');
define('row', 'строка', 'ряд');
define('column', 'колонка', 'столбец', 'колонки');
define('grid', 'сетка');
define('block', 'блок');
define('section', 'секция', 'раздел', 'секции');
define('container', 'контейнер');
define('wrapper', 'обертка');
define('content', 'контент', 'содержимое');
define('background', 'фон', 'подложка');
define('photo', 'фото', 'фотография');
define('image', 'изображение', 'картинка', 'изображения', 'картинки');
define('avatar', 'аватар', 'аватарка');
define('logo', 'логотип', 'лого');
define('form', 'форма');
define('search', 'поиск');
define('login', 'вход');
define('signup', 'регистрация');
define('profile', 'профиль');
define('settings', 'настройки');
define('notification', 'уведомление');
define('notifications', 'уведомления');
// «Подсказка» under a field is a hint; a floating one is named «тултип».
define('hint', 'подсказка', 'подсказки');
define('tooltip', 'тултип');
define('tab', 'вкладка', 'таб');
define('tabs', 'вкладки', 'табы');
define('modal', 'модальное', 'модалка');
define('window', 'окно');
define('dialog', 'диалог');
define('switch', 'переключатель', 'свитч');
define('toggle', 'тумблер');
define('checkbox', 'чекбокс');
define('radio', 'радиокнопка', 'радио');
define('slider', 'слайдер', 'ползунок');
define('select', 'селект');
define('dropdown', 'выпадающий', 'дропдаун');
define('arrow', 'стрелка', 'стрелку', 'стрелки');
define('close', 'закрыть', 'крестик');
define('back', 'назад');
define('next', 'далее', 'вперед', 'дальше');
define('submit', 'отправить');
define('cancel', 'отмена', 'отменить');
define('save', 'сохранить');
define('delete', 'удалить');
define('add', 'добавить');
define('edit', 'изменить', 'редактировать');
define('buy', 'купить');
define('cart', 'корзина');
define('price', 'цена', 'цены');
define('product', 'товар', 'товара', 'продукт');
define('products', 'товары');
define('catalog', 'каталог');
define('home', 'главная');
define('page', 'страница', 'страницы');
define('screen', 'экран');
define('banner', 'баннер');
define('slide', 'слайд');
define('review', 'отзыв');
define('reviews', 'отзывы');
define('description', 'описание');
define('title', 'название');
define('name', 'имя');
define('date', 'дата');
define('time', 'время');
define('count', 'количество', 'счетчик');
define('rating', 'рейтинг');
define('star', 'звезда', 'звездочка');
define('user', 'пользователь');
define('contacts', 'контакты');
define('phone', 'телефон');
define('email', 'почта');
define('address', 'адрес');
define('map', 'карта');
define('video', 'видео');
define('progress', 'прогресс');
define('divider', 'разделитель');
define('surface', 'поверхность');
define('border', 'граница', 'бордер');
define('on', 'на');
define('status', 'статус', 'статусы');
define('author', 'автор');
define('actions', 'действия');
define('action', 'действие');
define('stats', 'статистика');
define('cover', 'обложка');
define('value', 'значение');
define('feed', 'лента');
define('privacy', 'конфиденциальность');
define('password', 'пароль');
define('logout', 'выход');
define('account', 'кабинет', 'аккаунт');
define('personal', 'личный');
define('article', 'статья');
define('articles', 'статьи');
define('reader', 'читатель');
define('readers', 'читатели');
define('subscription', 'подписка');
define('subscriptions', 'подписки');
define('order', 'заказ');
define('orders', 'заказы');
define('payment', 'оплата');
define('history', 'история');
define('data', 'данные');
define('total', 'итого', 'итог');
define('amount', 'сумма');
define('delivery', 'доставка');
define('city', 'город');
define('company', 'компания');
define('team', 'команда');
define('project', 'проект');
define('projects', 'проекты');
define('task', 'задача');
define('tasks', 'задачи');
define('file', 'файл');
define('files', 'файлы');
define('folder', 'папка');
define('event', 'событие');
define('events', 'события');
define('news', 'новости');
define('blog', 'блог');
define('about', 'онас');
define('services', 'услуги');
define('plan', 'тариф');
define('plans', 'тарифы');
define('features', 'преимущества', 'возможности', 'функции');
define('faq', 'вопросы');
define('answer', 'ответ');
define('step', 'шаг');
define('steps', 'шаги');
define('client', 'клиент');
define('clients', 'клиенты');
define('partner', 'партнер');
define('partners', 'партнеры');
define('chip', 'чип');
define('indicator', 'индикатор');
define('dot', 'точка');
define('dash', 'черта', 'черточка', 'тире');
define('box', 'флажок');
define('knob', 'ручка');
define('track', 'трек', 'дорожка');
define('checked', 'отмечен', 'отмечена', 'отмечено', 'отмечены');
define('mixed', 'частично', 'частичный', 'частичная', 'неопределенный', 'неопределенное');
define('overlay', 'оверлей', 'затемнение');
define('sheet', 'шторка');
define('toast', 'тост');
define('loader', 'загрузчик', 'лоадер');
define('spinner', 'спиннер');
define('pagination', 'пагинация');
define('breadcrumbs', 'крошки');
define('table', 'таблица');
define('cell', 'ячейка');
define('counter', 'счетчик');
define('chart', 'график', 'диаграмма');
define('caption', 'надпись');
define('placeholder', 'плейсхолдер');
define('body', 'тело');
define('statusbar', 'статусбар');
define('tabbar', 'таббар');
define('toolbar', 'тулбар');
define('sidebar', 'сайдбар');
define('navbar', 'навбар');
define('player', 'плеер');
define('gallery', 'галерея');
define('carousel', 'карусель');
define('accordion', 'аккордеон');
define('stepper', 'степпер');
define('rating', 'оценка');
define('discount', 'скидка');
define('sale', 'распродажа');
// Icons
define('plus', 'плюс');
define('minus', 'минус');
define('check', 'галочка', 'галка', 'чек');
define('chevron', 'шеврон');
define('heart', 'сердце', 'сердечко');
define('bell', 'колокольчик', 'звонок');
define('eye', 'глаз');
define('lock', 'замок');
define('filter', 'фильтр');
define('calendar', 'календарь');
define('clock', 'часы');
define('location', 'геолокация', 'локация', 'метка карты');
define('share', 'поделиться');
define('download', 'скачать');
define('upload', 'загрузить');
define('refresh', 'обновить');
define('copy', 'копировать');
define('up', 'вверх');
define('down', 'вниз');
define('burger', 'бургер', 'гамбургер');
define('like', 'лайк');
define('favorite', 'избранное');
define('question', 'вопрос');
define('play', 'плей', 'воспроизвести');
define('pause', 'пауза');
define('chat', 'чат');
define('message', 'сообщение');
define('messages', 'сообщения');
define('bookmark', 'закладка', 'закладки', 'закладку');
define('initials', 'инициалы');
define('moon', 'луна');
define('sun', 'солнце');
define('send', 'отправка');
define('trash', 'мусорка');
define('more', 'еще', 'ещё');
// Layers
define('frame', 'фрейм');
define('group', 'группа');
define('rectangle', 'прямоугольник');
define('ellipse', 'эллипс');
define('circle', 'круг', 'кружок');
define('line', 'линия');
define('vector', 'вектор');
define('polygon', 'многоугольник');
define('layer', 'слой');
define('component', 'компонент');
define('instance', 'экземпляр');
define('variant', 'вариант');
define('shape', 'фигура');
// Properties
define('size', 'размер');
define('state', 'состояние');
define('type', 'тип');
define('kind', 'вид');
define('color', 'цвет', 'цвета', 'цветов');
define('theme', 'тема');
define('mode', 'режим');
define('style', 'стиль');
define('spacing', 'отступ', 'отступы');
define('radius', 'радиус', 'скругление');
define('shadow', 'тень', 'тени');
define('blur', 'размытие');
define('font', 'шрифт');
define('width', 'ширина');
define('height', 'высота');
define('stroke', 'обводка');
define('fill', 'заливка');
define('opacity', 'прозрачность', 'непрозрачность');
define('show', 'показать', 'показывать');
define('hide', 'скрыть');
define('has', 'есть');
define('with', 'с', 'со');
define('without', 'без');
define('untitled', 'безназвания');
// Values
define('primary', 'основная', 'основной', 'основное', 'основные', 'главный', 'первичная', 'первичный');
define('secondary', 'вторичная', 'вторичный', 'второстепенная', 'второстепенный', 'дополнительная', 'дополнительный');
define('tertiary', 'третичная', 'третичный');
define('accent', 'акцент', 'акцентная', 'акцентный');
define('neutral', 'нейтральная', 'нейтральный');
define('ghost', 'призрачная', 'призрачный', 'прозрачная', 'прозрачный');
define('outline', 'контурная', 'контурный', 'контур');
// «Текстовая кнопка» is a link-styled button: the common English for that variant is "text".
define('text', 'текстовая', 'текстовый', 'текстовое');
define('large', 'большая', 'большой', 'большое', 'большие', 'крупная', 'крупный', 'крупное');
define('medium', 'средняя', 'средний', 'среднее', 'средние');
define('small', 'маленькая', 'маленький', 'маленькое', 'маленькие', 'малая', 'малый', 'мелкий', 'мелкая');
define('light', 'светлая', 'светлый', 'светлое', 'светлые');
define('dark', 'темная', 'темный', 'темное', 'темные');
define('hover', 'наведение', 'ховер', 'наведении');
define('pressed', 'нажатие', 'нажата', 'нажатая', 'нажатый', 'нажатое');
define('active', 'активная', 'активный', 'активное', 'активна', 'активен');
define('inactive', 'неактивная', 'неактивный', 'неактивное');
define('disabled', 'отключена', 'отключен', 'отключено', 'отключенная', 'отключенный', 'недоступна', 'недоступен', 'недоступная', 'недоступный', 'заблокирована', 'заблокирован');
define('focus', 'фокус', 'фокусе');
define('selected', 'выбрано', 'выбран', 'выбрана', 'выбранный', 'выбранная');
define('default', 'обычная', 'обычный', 'обычное', 'обычные', 'стандартная', 'стандартный', 'стандарт', 'дефолт');
define('error', 'ошибка', 'ошибки');
define('success', 'успех', 'успешно');
define('warning', 'предупреждение', 'внимание');
define('info', 'информация', 'инфо');
define('loading', 'загрузка');
define('empty', 'пустая', 'пустой', 'пусто', 'пустое');
define('filled', 'заполнена', 'заполнен', 'заполненный', 'заполненная');
define('open', 'открыта', 'открыт', 'открытый', 'открытая', 'открыто');
define('closed', 'закрыта', 'закрытый', 'закрытая', 'закрыто');
define('on', 'вкл', 'включено', 'включен', 'включена');
define('off', 'выкл', 'выключено', 'выключен', 'выключена');
define('yes', 'да');
define('no', 'нет');
define('white', 'белый', 'белая', 'белое');
define('black', 'черный', 'черная', 'черное');
define('gray', 'серый', 'серая', 'серое');
define('red', 'красный', 'красная');
define('blue', 'синий', 'синяя');
define('light blue', 'голубой', 'голубая');
define('green', 'зеленый', 'зеленая');
define('yellow', 'желтый', 'желтая');
define('orange', 'оранжевый', 'оранжевая');
define('purple', 'фиолетовый', 'фиолетовая');
define('pink', 'розовый', 'розовая');
define('brown', 'коричневый', 'коричневая');
define('brand', 'бренд', 'брендовый', 'брендовая');
define('left', 'левый', 'левая', 'слева');
define('right', 'правый', 'правая', 'справа');
define('top', 'верхний', 'верхняя', 'сверху');
define('bottom', 'нижний', 'нижняя', 'снизу');
define('center', 'центр');
define('horizontal', 'горизонтальный', 'горизонтальная');
define('vertical', 'вертикальный', 'вертикальная');
define('desktop', 'десктоп', 'компьютер');
define('mobile', 'мобильная', 'мобильный', 'мобайл');
define('tablet', 'планшет');
define('version', 'версия');
define('new', 'новый', 'новая', 'новое');
define('first', 'первый', 'первая');
define('second', 'второй', 'вторая');
define('main', 'основа');
define('density', 'плотность');
define('compact', 'компактная', 'компактный', 'компактное');
define('comfortable', 'просторная', 'просторный');
define('weight', 'насыщенность', 'начертание', 'вес');
define('hero', 'герой', 'героя', 'хиро');
define('landing', 'лендинг', 'лендинга');
define('promo', 'промо');

const normalize = (word: string) => word.toLowerCase().replace(/ё/g, 'е');

/** Russian endings, longest first: «Нейтральные» and «нейтральная» share the stem «нейтральн». */
const ENDINGS = ['ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ией', 'ия', 'ие', 'ий', 'ый', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ов', 'ев', 'ей', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ою', 'ею', 'ую', 'юю', 'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о', 'ь', 'й'];
const MIN_STEM = 4;

function stemOf(word: string): string | null {
  for (const ending of ENDINGS) if (word.endsWith(ending) && word.length - ending.length >= MIN_STEM) return word.slice(0, -ending.length);
  return null;
}

/** Stem → English for the Cyrillic forms in the table; a stem two words share with different meanings is left out,
 *  so «Показать подсказку» finds «подсказка» but no form ever guesses between two words. */
const STEMS: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string | null>();
  for (const [form, english] of Object.entries(WORDS)) {
    if (!/[а-я]/.test(form)) continue;
    for (const stem of new Set([stemOf(form), form.length >= MIN_STEM ? form : null])) {
      if (!stem) continue;
      const seen = out.get(stem);
      out.set(stem, seen === undefined || seen === english ? english : null);
    }
  }
  return new Map([...out].filter((entry): entry is [string, string] => entry[1] !== null));
})();

/** The English for one word of a name: the table's form, else the form's stem. */
function knownWord(part: string): string | undefined {
  const word = normalize(part);
  const exact = WORDS[word];
  if (exact) return exact;
  const stem = stemOf(word);
  return stem ? STEMS.get(stem) : undefined;
}

/** Phrases that name one thing. */
const PHRASES: [RegExp, string][] = [
  [/по\s+умолчанию/giu, 'дефолт'], [/по\s+центру/giu, 'центр'], [/поле\s+ввода/giu, 'инпут'], [/модальное\s+окно/giu, 'модалка'], [/выпадающий\s+список/giu, 'дропдаун'],
  // A new file's name: «Без названия» → untitled, not "without-nazvaniya".
  [/без\s+названия/giu, 'безназвания'],
];

/** Cyrillic letters to Latin (a practical scheme close to passports and Yandex: «щ» → shch, «ж» → zh). */
export function transliterate(text: string): string {
  let out = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    const latin = TRANSLIT[lower];
    if (latin === undefined) out += char;
    else out += char !== lower && latin ? latin[0].toUpperCase() + latin.slice(1) : latin;
  }
  return out;
}

/** Latin words of a name: known words translated, the rest transliterated, punctuation dropped,
 *  camelCase split. «Кнопка/Основная» → ['button', 'primary']; «Фото зёрен» → ['photo', 'zeren']. */
export function nameWords(name: string): string[] {
  // Two-word phrases first, so «по умолчанию» becomes one word.
  const phrased = PHRASES.reduce((text, [pattern, word]) => text.replace(pattern, word), name);
  const words: string[] = [];
  for (const part of phrased.split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue;
    const known = knownWord(part);
    if (known) {
      words.push(...known.split(' '));
      continue;
    }
    const latin = transliterate(part).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, ' ').trim();
    // camelCase boundaries inside Latin words: "primaryButton" → primary button
    for (const piece of latin.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')) if (piece) words.push(piece.toLowerCase());
  }
  return words;
}

const capital = (word: string) => (word ? word[0].toUpperCase() + word.slice(1) : word);

export const pascalCase = (words: readonly string[]) => words.map(capital).join('');
export const camelCase = (words: readonly string[]) => words.map((word, i) => (i ? capital(word) : word)).join('');
export const kebabCase = (words: readonly string[]) => words.join('-');

/** JavaScript words that cannot name a variable or a prop shorthand. */
export const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public',
  'await', 'async', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity',
]);

/** A PascalCase identifier from a layer name, or `fallback` when the name gives nothing usable. */
export function componentName(name: string, fallback = 'Layer'): string {
  const words = nameWords(name);
  let id = pascalCase(words);
  if (!id) return fallback;
  if (/^[0-9]/.test(id)) id = fallback + id;
  return id;
}

/** A camelCase identifier (props, classes, imports). */
export function memberName(name: string, fallback = 'layer'): string {
  const words = nameWords(name);
  let id = camelCase(words);
  if (!id) return fallback;
  if (/^[0-9]/.test(id)) id = fallback + capital(id);
  if (RESERVED_WORDS.has(id)) id = id + 'Value';
  return id;
}

/** kebab-case for files and CSS custom properties. */
export function slugName(name: string, fallback = 'layer'): string {
  const slug = kebabCase(nameWords(name));
  return slug || fallback;
}

/** Names the editor or Figma give a new layer («Фрейм», "Frame 12", "Rectangle 3"): they say what the layer is, not what it is for. */
const DEFAULT_LAYER_NAME = /^(фрейм|группа|секция|прямоугольник|эллипс|линия|стрелка|вектор|многоугольник|звезда|экземпляр|булева операция|объединение|вычитание|пересечение|исключение|изображение|слой|frame|group|section|rectangle|ellipse|line|arrow|vector|polygon|star|instance|union|subtract|intersect|exclude|image|layer|container|div|auto ?layout)(\s*\d+)?$/i;
const DEFAULT_TEXT_NAME = /^(текст|text)(\s*\d+)?$/i;

/** Whether a name is one the editor or Figma gave (a text named «Текст» is; a frame named «Текст» was named so). */
export const isDefaultLayerName = (name: string, type?: string) => DEFAULT_LAYER_NAME.test(name.trim()) || ((type === undefined || type === 'TEXT') && DEFAULT_TEXT_NAME.test(name.trim()));

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Whether a text layer is named after what it says (Figma and the editor name a new text by its first characters):
 *  such a name is content, and content never names a class («Мария Орлова» is not `mariyaOrlova`). */
export function isContentName(name: string, characters: string): boolean {
  const own = collapse(name), text = collapse(characters);
  if (!own) return true;
  return own === text || (own.length >= 12 && text.startsWith(own.replace(/…$/, '')));
}

const IRREGULAR_PLURALS: Record<string, string> = {person: 'people', child: 'children', datum: 'data', index: 'indices', news: 'news', data: 'data', stats: 'stats', settings: 'settings', faq: 'faq', contacts: 'contacts'};
const IRREGULAR_SINGULARS: Record<string, string> = Object.fromEntries([...Object.entries(IRREGULAR_PLURALS).filter(([one, many]) => one !== many).map(([one, many]) => [many, one]), ['stats', 'stat'], ['settings', 'setting'], ['contacts', 'contact'], ['news', 'newsItem'], ['data', 'item'], ['faq', 'question']]);

/** An English plural of the last word of a camelCase name: card → cards, category → categories, stat → stats. */
export function pluralName(name: string): string {
  const match = /^(.*?)([A-Za-z][a-z0-9]*)$/.exec(name);
  if (!match) return name + 's';
  const [, head, last] = match;
  const lower = last.toLowerCase();
  const keep = (word: string) => head + (last[0] === last[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word);
  if (Object.hasOwn(IRREGULAR_PLURALS, lower)) return keep(IRREGULAR_PLURALS[lower]!);
  if (/[^aeiou]y$/.test(lower)) return keep(lower.slice(0, -1) + 'ies');
  if (/(s|x|z|ch|sh)$/.test(lower)) return keep(lower + 'es');
  return keep(lower + 's');
}

/** The singular of a camelCase name's last word: cards → card, categories → category; a name that is no plural gets `Item`. */
export function singularName(name: string): string {
  const match = /^(.*?)([A-Za-z][a-z0-9]*)$/.exec(name);
  if (!match) return name + 'Item';
  const [, head, last] = match;
  const lower = last.toLowerCase();
  const keep = (word: string) => head + (last[0] === last[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word);
  if (Object.hasOwn(IRREGULAR_SINGULARS, lower)) return keep(IRREGULAR_SINGULARS[lower]!);
  if (/ies$/.test(lower) && lower.length > 4) return keep(lower.slice(0, -3) + 'y');
  if (/(ses|xes|zes|ches|shes)$/.test(lower)) return keep(lower.slice(0, -2));
  if (/[^s]s$/.test(lower) && lower.length > 3) return keep(lower.slice(0, -1));
  return name + 'Item';
}

/** Hands out each name once in a scope. Comparison ignores case, so `Button` and `button` cannot
 *  both become files on a case-insensitive disk; the first claimant keeps the plain name. */
export class NameRegistry {
  private readonly taken = new Set<string>();
  private readonly fold: (name: string) => string;
  /** Case-insensitive by default (file names); identifiers inside a file pass `caseSensitive`. */
  constructor(reserved: Iterable<string> = [], options: {caseSensitive?: boolean} = {}) {
    this.fold = options.caseSensitive ? name => name : name => name.toLowerCase();
    for (const name of reserved) this.taken.add(this.fold(name));
  }

  has(name: string) {
    return this.taken.has(this.fold(name));
  }

  /** `base` if free, else `base2`, `base3`… (a base ending in a digit gets `_2`). */
  claim(base: string): string {
    let name = base;
    const joiner = /[0-9]$/.test(base) ? '_' : '';
    for (let n = 2; this.taken.has(this.fold(name)); n++) name = `${base}${joiner}${n}`;
    this.taken.add(this.fold(name));
    return name;
  }

  reserve(name: string) {
    this.taken.add(this.fold(name));
  }
}

/** A safe value of a string union («Большой» → 'large'); always ASCII letters and digits. */
export function valueName(value: string, fallback = 'value'): string {
  const words = nameWords(value);
  const id = camelCase(words);
  return id || fallback;
}
