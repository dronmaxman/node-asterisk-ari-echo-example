'use strict';

require('dotenv').config();
const ari = require('ari-client');
const dgram = require('dgram');

const {
  ARI_BASE_URL,
  ARI_MEDIA_APP,
  ARI_USER,
  ARI_PASS,
  ARI_VERIFY_SSL,
  RTP_ADVERTISE_HOST,
  RTP_PORT,
  EXT_MEDIA_FORMAT,
  BRIDGE_TYPE,
} = process.env;

// Вимкнути перевірку SSL-сертифіката якщо потрібно
if (ARI_VERIFY_SSL === '0') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const RECORD_MS = 5000;
const RTP_PORT_NUM = parseInt(RTP_PORT, 10) || 18080;
const AUDIO_FORMAT = EXT_MEDIA_FORMAT || 'alaw';

// G.711 alaw/ulaw: 8000 Гц, 20 мс на пакет = 160 семплів
const SAMPLES_PER_PACKET = 160;
const CLOCK_RATE = 8000; // eslint-disable-line no-unused-vars

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Обробка одного дзвінка
// --------------------------------------------------------------------------
async function handleCall(client, channel) {
  const callerId = channel.caller?.number || 'unknown';
  const tag = `[${channel.id.slice(0, 8)} ${callerId}]`;

  console.log(`${tag} Вхідний дзвінок`);

  const packets = [];
  let asteriskAddr = null;
  let asteriskPort = null;
  let bridge = null;
  let extChan = null;
  const udp = dgram.createSocket('udp4');

  // -----------------------------------------------------------------------
  const cleanup = async () => {
    try { udp.close(); } catch (_) {}
    if (bridge) {
      try {
        await client.bridges.destroy({ bridgeId: bridge.id });
      } catch (_) {}
    }
    if (extChan) {
      try { await extChan.hangup(); } catch (_) {}
    }
    try { await channel.hangup(); } catch (_) {}
    console.log(`${tag} Завершено. Очікуємо наступний дзвінок...\n`);
  };
  // -----------------------------------------------------------------------

  try {
    // 1. Прив'язати UDP-сокет ДО відповіді — щоб не пропустити перші пакети
    await new Promise((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(RTP_PORT_NUM, '0.0.0.0', resolve);
    });
    console.log(`${tag} UDP RTP сервер слухає порт ${RTP_PORT_NUM}`);

    // 2. Відповісти на дзвінок
    await channel.answer();
    console.log(`${tag} Дзвінок прийнято`);

    // 3. Створити ExternalMedia-канал
    //    direction: 'both' — Asterisk відправляє аудіо нам і приймає від нас
    extChan = await client.channels.externalMedia({
      app: ARI_MEDIA_APP,
      external_host: `${RTP_ADVERTISE_HOST}:${RTP_PORT_NUM}`,
      format: AUDIO_FORMAT,
      direction: 'both',
    });
    console.log(`${tag} ExternalMedia канал: ${extChan.id}`);

    // 4. Створити міст і додати обидва канали
    bridge = await client.bridges.create({ type: BRIDGE_TYPE || 'mixing' });
    console.log(`${tag} Міст: ${bridge.id}`);

    await client.bridges.addChannel({
      bridgeId: bridge.id,
      channel: [channel.id, extChan.id],
    });
    console.log(`${tag} Обидва канали додано до мосту`);

    // ====================================================================
    // ФАЗА 1: ЗАПИС — 5 секунд
    // ====================================================================
    console.log(`${tag} *** ЗАПИС ${RECORD_MS / 1000} сек... ***`);

    udp.on('message', (msg, rinfo) => {
      if (!asteriskAddr) {
        asteriskAddr = rinfo.address;
        asteriskPort = rinfo.port;
        console.log(`${tag} Asterisk RTP джерело: ${asteriskAddr}:${asteriskPort}`);
      }
      packets.push({ data: Buffer.from(msg), time: Date.now() });
    });

    await sleep(RECORD_MS);

    udp.removeAllListeners('message');
    console.log(`${tag} Записано ${packets.length} RTP пакетів`);

    // ====================================================================
    // ФАЗА 2: ВІДТВОРЕННЯ — 5 секунд
    // ====================================================================
    if (packets.length === 0 || !asteriskAddr) {
      console.log(`${tag} Немає записаних пакетів, відтворення пропущено`);
    } else {
      console.log(`${tag} *** ВІДТВОРЕННЯ ${packets.length} пакетів → ${asteriskAddr}:${asteriskPort} ***`);

      // Беремо seq/ts з першого пакету та будуємо нову послідовність,
      // щоб Asterisk правильно прийняв RTP-потік
      const firstSeq = packets[0].data.readUInt16BE(2);
      const firstTs  = packets[0].data.readUInt32BE(4);
      const newSsrc  = (Math.random() * 0xFFFFFFFF) >>> 0;

      const startTime = packets[0].time;
      const playStart = Date.now();

      for (let i = 0; i < packets.length; i++) {
        // Дочекатись потрібного моменту (зберігаємо оригінальний тайминг)
        const delay = (packets[i].time - startTime) - (Date.now() - playStart);
        if (delay > 0) await sleep(delay);

        // Клонуємо буфер і патчимо RTP-заголовок
        const buf = Buffer.from(packets[i].data);
        buf.writeUInt16BE((firstSeq + i) & 0xFFFF, 2);       // sequence
        buf.writeUInt32BE(((firstTs + i * SAMPLES_PER_PACKET) >>> 0), 4); // timestamp
        buf.writeUInt32BE(newSsrc, 8);                         // SSRC

        udp.send(buf, asteriskPort, asteriskAddr);
      }

      console.log(`${tag} Відтворення завершено`);
    }

  } catch (err) {
    console.error(`${tag} Помилка:`, err.message || err);
  } finally {
    await cleanup();
  }
}

// --------------------------------------------------------------------------
// Підключення до ARI та очікування дзвінків
// --------------------------------------------------------------------------
ari.connect(ARI_BASE_URL, ARI_USER, ARI_PASS, (err, client) => {
  if (err) {
    console.error('Не вдалося підключитись до ARI:', err);
    process.exit(1);
  }

  console.log(`Підключено до Asterisk ARI: ${ARI_BASE_URL}`);
  console.log(`Додаток: ${ARI_MEDIA_APP}\n`);

  client.on('StasisStart', (event, channel) => {
    // Ігноруємо ExternalMedia-канали, які ми самі створюємо
    const name = channel.name || '';
    if (name.startsWith('UnicastRTP/') || name.startsWith('ExternalMedia/')) {
      return;
    }
    handleCall(client, channel);
  });

  client.on('StasisEnd', (event, channel) => {
    // Логуємо, але основна логіка завершення — у handleCall → cleanup
    const name = channel.name || '';
    if (!name.startsWith('UnicastRTP/') && !name.startsWith('ExternalMedia/')) {
      console.log(`[${channel.id.slice(0, 8)}] StasisEnd (канал вийшов із Stasis)`);
    }
  });

  client.start(ARI_MEDIA_APP);
});
