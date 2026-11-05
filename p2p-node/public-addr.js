/**
 * public-addr.js — какой адрес узел объявляет миру.
 *
 * ВЫНЕСЕНО ОТДЕЛЬНО И БЕЗ ЗАВИСИМОСТЕЙ, и это не стилистика. Проверить
 * «узел пишет в лог реальный WAN-адрес» можно только запустив узел, а он
 * тянет libp2p на сотню мегабайт. Логика разбора адреса не зависит от
 * libp2p вообще — она просто строка → multiaddr. Здесь её можно проверить
 * обычным node без установки сети.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ. `index.js` слушает `127.0.0.1` по умолчанию: на ноутбуке
 * это правильно, на VPS — нет. Узел, который объявляет loopback, для сети
 * неотличим от несуществующего: Peer ID есть, адреса нет. `P2P_PUBLIC_URL`
 * говорит узлу, каким его видят снаружи.
 */

'use strict'

/** Порт по умолчанию, если адрес задан без порта. Совпадает с P2P_PORT. */
const DEFAULT_PORT = 4001

/**
 * Домен это или IP. `dns4`/`dns6` для имён, `ip4`/`ip6` для литералов.
 * Разделение важно: libp2p не резолвит `dns4` в момент объявления, а `ip4`
 * с именем хоста отвергает как невалидный multiaddr.
 */
function classifyHost (host) {
  const bare = String(host).replace(/^\[|\]$/g, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return { proto: 'ip4', value: bare }
  if (bare.includes(':')) return { proto: 'ip6', value: bare }
  return { proto: 'dns4', value: bare }
}

/**
 * Разбирает `P2P_PUBLIC_URL` в список multiaddr.
 *
 * Поддерживаются формы, которые реально встречаются в systemd-юнитах:
 *   `https://v1107336.hosted-by-vdsina.com`   — публичный URL прокси
 *   `http://1.2.3.4:4001`                     — прямой адрес с портом
 *   `1.2.3.4:4001`                            — без схемы
 *   `/ip4/1.2.3.4/tcp/4001`                   — уже multiaddr
 *
 * @param {string} raw значение переменной
 * @param {number} listenPort порт, если в адресе не назван
 * @returns {{addrs: string[], source: string, note: string|null}}
 */
function resolvePublicAddrs (raw, listenPort = DEFAULT_PORT) {
  const value = String(raw == null ? '' : raw).trim()
  if (!value) {
    return {
      addrs: [],
      source: 'unset',
      /* Не ошибка: на локальной машине объявлять нечего. Но и молчать
       * нельзя — иначе «узел работает» будет означать только открытый
       * сокет на loopback. */
      note: 'P2P_PUBLIC_URL не задан — узел слушает локально и никому не объявлен'
    }
  }

  /* Уже multiaddr: доверяем как есть, но проверяем форму, чтобы опечатка
   * (`/ip4/1.2.3.4/4001` без `/tcp/`) не дошла до libp2p. */
  if (value.startsWith('/')) {
    if (!/^\/ip[46]\/[^/]+\/tcp\/\d+$/.test(value)) {
      return { addrs: [], source: 'invalid', note: `P2P_PUBLIC_URL не multiaddr: ${value}` }
    }
    return { addrs: [value], source: 'multiaddr', note: null }
  }

  let rest = value
  let hadScheme = false
  const schemeMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)
  if (schemeMatch) {
    hadScheme = true
    rest = rest.slice(schemeMatch[0].length)
  }

  /* Путь и query к адресу узла отношения не имеют: `https://host/app` —
   * это тот же хост. Отбрасываем, а не падаем. */
  rest = rest.split('/')[0].split('?')[0]

  if (!rest) {
    return { addrs: [], source: 'invalid', note: `P2P_PUBLIC_URL пуст после разбора схемы: ${value}` }
  }

  /* Порт: последний `:` вне скобок IPv6. */
  let host = rest
  let port = null
  const bracket = rest.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (bracket) {
    host = bracket[1]
    port = bracket[2] ? Number(bracket[2]) : null
  } else {
    const colon = rest.lastIndexOf(':')
    /* `host:port` отличается от голого IPv6 тем, что до двоеточия двоеточий
     * нет. Иначе ::1 разобрался бы как хост '' и порт '1'. */
    if (colon !== -1 && !rest.slice(0, colon).includes(':')) {
      const maybePort = rest.slice(colon + 1)
      if (/^\d+$/.test(maybePort)) {
        host = rest.slice(0, colon)
        port = Number(maybePort)
      }
    }
  }

  if (!host) {
    return { addrs: [], source: 'invalid', note: `P2P_PUBLIC_URL без хоста: ${value}` }
  }

  /* Порт из URL важнее listenPort только если он назван явно. Схема без
   * порта (`https://host`) означает прокси на 443, а не 4001 — но объявлять
   * узел на 443 нельзя, там слушает прокси, а не libp2p. Поэтому берём
   * listenPort и говорим об этом в note. */
  let note = null
  let effectivePort = port
  if (effectivePort == null) {
    effectivePort = listenPort
    if (hadScheme) {
      note = `в P2P_PUBLIC_URL нет порта — объявляю порт прослушивания ${listenPort}`
    }
  }

  const { proto, value: bare } = classifyHost(host)
  return {
    addrs: [`/${proto}/${bare}/tcp/${effectivePort}`],
    source: 'url',
    note
  }
}

/**
 * Предупреждение, если объявленный адрес недостижим при текущем прослушивании.
 * Отдельная функция: это правило проверки, а не часть разбора, и оно нужно
 * ровно для того, чтобы лог не врал «узел доступен».
 */
function listenMismatch (listenHost, addrs) {
  if (!addrs || addrs.length === 0) return null
  const loopback = listenHost === '127.0.0.1' || listenHost === 'localhost' || listenHost === '::1'
  if (!loopback) return null
  return `объявляю ${addrs.join(', ')}, но слушаю ${listenHost} — снаружи адрес недостижим, задайте P2P_HOST=0.0.0.0`
}

/* Пакет объявлен как `"type": "module"`, поэтому экспорт именованный, а не
 * `module.exports`: файл с расширением `.js` здесь исполняется как ESM, и
 * CommonJS-строка падает `ReferenceError: module is not defined`. */
export { DEFAULT_PORT, classifyHost, resolvePublicAddrs, listenMismatch }
