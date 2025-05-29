require('dotenv').config();
const fetch = require('node-fetch');
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const GROUP_ID = process.env.GROUP_ID;

const url = 'https://getgems.io/graphql/';
const operationName = 'nftSearch';

let lastPrices = {
  unrestrictedWith4: 0,
  unrestrictedWithout4: 0,
  restrictedWith4: 0,
  restrictedWithout4: 0
};

const body = {
  operationName,
  variables: {
    query: JSON.stringify({
      "$and": [
        { "collectionAddress": "EQAOQdwdw8kGftJCSFgOErM1mBjYPe4DBPq8-AhF6vr9si5N" }
      ]
    }),
    attributes: null,
    sort: JSON.stringify([
      { "isOnSale": { "order": "desc" } },
      { "price": { "order": "asc" } },
      { "index": { "order": "asc" } }
    ]),
    count: 50
  },
  extensions: {
    persistedQuery: {
      version: 1,
      sha256Hash: "5157c5387ebe1ade6140489ed747a553840f6c3dffe03bb09e92ab565076e29d"
    }
  }
};

function formatTON(ton) {
  return (parseInt(ton) / 1e9).toFixed(2);
}

function formatName(name) {
  return name.replace(/(4)/g, '<ins>$1</ins>');
}

function analyze(items, isRestricted) {
  const filtered = items
    .filter(item => item.sale && (getPrice(item) > 0)) // 排除价格无效项
    .filter(item =>
      isRestricted ? item.warningBanner !== null : item.warningBanner === null
    );

  const with4 = filtered.filter(nft => nft.name.includes('4'));
  const without4 = filtered.filter(nft => !nft.name.includes('4'));

  // 找到最便宜的项，并确保价格有效
  const cheapestWith4 = with4
    .sort((a, b) => getPrice(a) - getPrice(b))[0];

  const cheapestWithout4 = without4
    .sort((a, b) => getPrice(a) - getPrice(b))[0];

  return { cheapestWith4, cheapestWithout4 };
}

function getPrice(nft) {
  if (!nft || !nft.sale || !nft.sale.__typename) return 0;

  if (nft.sale.__typename === 'NftSaleFixPrice') {
    const fullPrice = parseInt(nft.sale.fullPrice);
    return isNaN(fullPrice) || fullPrice <= 0 ? 0 : fullPrice;
  } else if (nft.sale.__typename === 'TelemintAuction') {
    const maxBidAmount = parseInt(nft.sale.telemintMaxBidAmount);
    return isNaN(maxBidAmount) || maxBidAmount <= 0 ? 0 : maxBidAmount;
  }

  return 0;
}

function getPurchaseLink(nft) {
  const collectionAddress = "EQAOQdwdw8kGftJCSFgOErM1mBjYPe4DBPq8-AhF6vr9si5N";
  const nftAddress = nft.address;  // 从 NFT 数据中提取地址
  return `https://getgems.io/collection/${collectionAddress}/${nftAddress}`;
}

// 查询 NFT 并返回信息
async function fetchNftData() {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-apollo-operation-name': operationName,
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    });

    const json = await res.json();

    if (json.errors) {
      console.error('GraphQL Errors:', JSON.stringify(json.errors, null, 2));
      return;
    }

    const edges = json?.data?.alphaNftItemSearch?.edges;
    if (!edges) {
      console.error('No edges found:', JSON.stringify(json, null, 2));
      return;
    }

    const items = edges.map(edge => edge.node);
    const unrestricted = analyze(items, false);
    const restricted = analyze(items, true);

    const prices = {
      unrestrictedWith4: getPrice(unrestricted.cheapestWith4),
      unrestrictedWithout4: getPrice(unrestricted.cheapestWithout4),
      restrictedWith4: getPrice(restricted.cheapestWith4),
      restrictedWithout4: getPrice(restricted.cheapestWithout4),
    };

    let text = `<b>[888] 地板价</b>\n`;

    if (unrestricted.cheapestWith4) {
      text += `<b>[含4]</b>  <a href="${getPurchaseLink(unrestricted.cheapestWith4)}">${formatName(unrestricted.cheapestWith4.name)}</a> 💎<b>${formatTON(prices.unrestrictedWith4)}</b>\n`;
    }

    if (unrestricted.cheapestWithout4) {
      text += `<b>[无4]</b>  <a href="${getPurchaseLink(unrestricted.cheapestWithout4)}">${formatName(unrestricted.cheapestWithout4.name)}</a> 💎<b>${formatTON(prices.unrestrictedWithout4)}</b>\n`;
    }

    text += `=======================\n`;
    text += `<b>[888] 地板价~受限</b>\n`;

    if (restricted.cheapestWith4) {
      text += `<b>[含4]</b>  <a href="${getPurchaseLink(restricted.cheapestWith4)}">${formatName(restricted.cheapestWith4.name)}</a> 💎<b>${formatTON(prices.restrictedWith4)}</b>\n`;
    }

    if (restricted.cheapestWithout4) {
      text += `<b>[无4]</b>  <a href="${getPurchaseLink(restricted.cheapestWithout4)}">${formatName(restricted.cheapestWithout4.name)}</a> 💎<b>${formatTON(prices.restrictedWithout4)}</b>\n`;
    }

    return { text, prices };

  } catch (err) {
    console.error('Fetch error:', err);
  }
}

// 定时查询并发送到指定群组
setInterval(async () => {
  const message = await fetchNftData();

  if (!message || !message.prices) return;

  const { text, prices } = message;

  let shouldSend = false;
  let shouldMention = false;

  const priceKeys = Object.keys(prices);

  for (const key of priceKeys) {
    const newPrice = prices[key];
    const lastPrice = lastPrices[key] || 0;

    if (newPrice !== lastPrice) {
      shouldSend = true;

      if (Math.abs(formatTON(newPrice) - formatTON(lastPrice)) >= 50) {
        shouldMention = true;
      }

      lastPrices[key] = newPrice;  // 更新缓存
    }
  }

  if (shouldSend) {
    const sentMsg = await bot.telegram.sendMessage(GROUP_ID, text, {
      disable_web_page_preview: true,
      parse_mode: 'HTML'
    });
    if (shouldMention) {
        await bot.telegram.pinChatMessage(GROUP_ID, sentMsg.message_id, {
          disable_notification: false
        });
      }
  }
}, 15000);

// 启动 Bot
bot.launch().then(() => {
  console.log('Bot is running...');
});
