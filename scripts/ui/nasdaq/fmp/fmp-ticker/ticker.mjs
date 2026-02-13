const API_KEY = "TNQATNqowKe9Owu1zL9QurgZCXx9Q1BS";


const SYMBOL = "TSLA";


const URL = `https://financialmodelingprep.com/stable/quote-short?symbol=${encodeURIComponent(SYMBOL)}&apikey=${encodeURIComponent(API_KEY)}`;

async function fetchPrice() {
  const res = await fetch(URL, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);

  const data = await res.json(); 
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Empty payload: ${JSON.stringify(data)}`);
  }
  return data[0].price;
}

while (true) {
  try {
    const price = await fetchPrice();
    console.log(`${new Date().toISOString()} TSLA: $${price}`);
  } catch (e) {
    console.log(`${new Date().toISOString()} Fetch failed: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 15000));
  
}
