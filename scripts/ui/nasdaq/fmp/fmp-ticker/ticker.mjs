const API_KEY = "TNQATNqowKe9Owu1zL9QurgZCXx9Q1BS";
const SYMBOL = "TSLA";

const encodedSymbol = encodeURIComponent(SYMBOL);
const encodedApiKey = encodeURIComponent(API_KEY);
const URL = `https://financialmodelingprep.com/stable/quote-short?symbol=${encodedSymbol}&apikey=${encodedApiKey}`;

async function fetchPrice() {
  const response = await fetch(URL, { headers: { Accept: "application/json" } });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} ${body}`);
  }

  const data = await response.json();
  const isArray = Array.isArray(data);
  const hasData = isArray && data.length > 0;

  if (!hasData) {
    throw new Error(`Empty payload: ${JSON.stringify(data)}`);
  }

  const first = data[0];
  return first.price;
}

while (true) {
  try {
    const price = await fetchPrice();
    const now = new Date().toISOString();
    console.log(`${now} TSLA: $${price}`);
  } catch (error) {
    const now = new Date().toISOString();
    let message = String(error);
    if (error && error.message) {
      message = error.message;
    }
    console.log(`${now} Fetch failed: ${message}`);
  }

  await new Promise((resolve) => {
    setTimeout(resolve, 15000);
  });
}
