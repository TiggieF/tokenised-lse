from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.data.enums import DataFeed
import plotly.graph_objects as go
import pandas as pd
from datetime import datetime, timedelta

API_KEY = "PKDQTXIA3IPUMEHZDAQ3EPORGE"        
API_SECRET = "BjPuojJSTo548cPH85RpppnpeTZGWor7C9hjKbDCuYHg"

client = StockHistoricalDataClient(API_KEY, API_SECRET)

# Use the last 30 minutes relative to now (UTC)
end_time = datetime.utcnow()
start_time = end_time - timedelta(minutes=30)

# Request 1-minute bars for today
request = StockBarsRequest(
    symbol_or_symbols="AAPL",
    timeframe=TimeFrame.Minute,
    start=start_time,
    end=end_time,
    feed=DataFeed.IEX
)

bars = client.get_stock_bars(request)

# Convert to DataFrame and normalize timestamp column
df = bars.df.reset_index()
if df.empty:
    raise ValueError("No bar data returned for the last 30 minutes. Check market hours or the selected feed.")
time_col = next(
    (col for col in df.columns if "timestamp" in str(col).lower() or str(col).lower() == "time"),
    None,
)
if time_col is None:
    raise KeyError(f"No timestamp-like column returned in response columns: {list(df.columns)}")
if time_col != "time":
    df.rename(columns={time_col: "time"}, inplace=True)

# Plot candlestick chart
fig = go.Figure([
    go.Candlestick(
        x=df["time"],
        open=df["open"],
        high=df["high"],
        low=df["low"],
        close=df["close"]
    )
])

fig.update_layout(
    title="AAPL — Today's Intraday Candlestick Chart",
    xaxis_rangeslider_visible=False
)

# Save to HTML
fig.write_html("today_candles.html")
print("Saved today_candles.html")
