import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NameRegistry, componentName, memberName, nameWords, pluralName, slugName, transliterate, valueName} from '../shared/design/codegen/names';

// Names in generated code: known interface words in English, everything else transliterated,
// identifiers always valid, collisions numbered in the order names are claimed.
// The Cyrillic inputs in this file are kept on purpose: it tests transliteration of Cyrillic layer names.

test('Cyrillic is transliterated letter by letter', () => {
  assert.equal(transliterate('Щука, ёж и Юла'), 'Shchuka, yozh i Yula');
  assert.equal(transliterate('Объём'), 'Obyom');
  assert.equal(componentName('Зерно'), 'Zerno');
  assert.equal(componentName('Кофейня «Зерно»'), 'KofeynyaZerno');
});

test('interface words become English, in any case and gender', () => {
  assert.equal(componentName('Кнопка/Основная'), 'ButtonPrimary');
  assert.equal(componentName('Карточка товара'), 'CardProduct');
  assert.equal(componentName('Заголовок'), 'Heading');
  assert.equal(componentName('Иконка/Стрелка'), 'IconArrow');
  assert.equal(componentName('Поле ввода'), 'Input');
  assert.equal(memberName('Показать иконку'), 'showIcon');
  assert.equal(valueName('Большой'), 'large');
  assert.equal(valueName('Маленькая'), 'small');
  assert.equal(valueName('Тёмная'), 'dark');
  assert.equal(valueName('По умолчанию'), 'default');
  assert.deepEqual(nameWords('Размер=Большой, Состояние=Наведение'), ['size', 'large', 'state', 'hover']);
  // The template kits' icon set and avatar: «Инициалы» was «initsialy», «Уведомления» «uvedomleniya».
  assert.equal(memberName('Инициалы'), 'initials');
  assert.equal(slugName('Без названия'), 'untitled');
  assert.equal(componentName('Без названия 2'), 'Untitled2');
  assert.deepEqual(['Уведомления', 'Сообщения', 'Закладка', 'Луна', 'Солнце'].map(word => valueName(word)), ['notifications', 'messages', 'bookmark', 'moon', 'sun']);
});

test('Latin names keep their words; camelCase is split', () => {
  assert.equal(componentName('primaryButton'), 'PrimaryButton');
  assert.equal(componentName('nav-bar_item'), 'NavBarItem');
  assert.equal(slugName('Hero Section 2'), 'hero-section-2');
});

test('identifiers are always valid', () => {
  assert.equal(componentName('1440 — десктоп'), 'Layer1440Desktop');
  assert.equal(componentName('!!!', 'Frame'), 'Frame');
  assert.equal(memberName('default'), 'defaultValue');
  assert.equal(memberName('123'), 'layer123');
  for (const name of ['Кнопка', '🙂 Эмодзи', 'a/b/c', '  ', 'Ελληνικά']) assert.match(componentName(name), /^[A-Z][A-Za-z0-9]*$/);
});

test('a layer named like an Object property is a word like any other', () => {
  // «Constructor» once threw in the word table's lookup and took the «Код» tab down with it.
  assert.deepEqual(nameWords('Constructor'), ['constructor']);
  assert.deepEqual(nameWords('toString'), ['to', 'string']);
  assert.equal(componentName('Constructor'), 'Constructor');
  assert.equal(pluralName('constructor'), 'constructors');
});

test('a registry hands each name out once, numbering repeats in claim order', () => {
  const files = new NameRegistry(['App']);
  assert.equal(files.claim('Button'), 'Button');
  assert.equal(files.claim('button'), 'button2', 'file names compare without case');
  assert.equal(files.claim('Button'), 'Button3');
  assert.equal(files.claim('App'), 'App2', 'reserved names are never handed out');
  assert.equal(files.claim('Layer1440'), 'Layer1440', 'free');
  assert.equal(files.claim('Layer1440'), 'Layer1440_2', 'a trailing digit gets a separator');
  const identifiers = new NameRegistry([], {caseSensitive: true});
  assert.equal(identifiers.claim('Icon'), 'Icon');
  assert.equal(identifiers.claim('icon'), 'icon', 'identifiers are case-sensitive');
});
