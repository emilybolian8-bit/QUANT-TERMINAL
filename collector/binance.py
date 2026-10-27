import asyncio
import aiohttp
from typing import Dict, List, Any
from loguru import logger

class BinanceCollector:
    def __init__(self):
        self.base_url = "https://fapi.binance.com"
        self.session = None
    
    async def get_tickers(self):
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{self.base_url}/fapi/v1/ticker/24hr") as resp:
                data = await resp.json()
                return [d for d in data if d['symbol'].endswith('USDT')]
    
    async def get_open_interest(self):
        tickers = await self.get_tickers()
        results = []
        async with aiohttp.ClientSession() as session:
            for ticker in tickers[:100]:  # Limit for now
                try:
                    symbol = ticker['symbol']
                    async with session.get(f"{self.base_url}/fapi/v1/openInterest?symbol={symbol}") as resp:
                        oi_data = await resp.json()
                        results.append({
                            'venue': 'binance',
                            'venue_symbol': symbol,
                            'base': symbol.replace('USDT', ''),
                            'oi_usd': float(oi_data.get('openInterest', 0)) * float(ticker['lastPrice']),
                            'price': float(ticker['lastPrice']),
                            'vol24h_usd': float(ticker['quoteVolume'])
                        })
                except Exception as e:
                    logger.error(f"Error fetching OI for {symbol}: {e}")
        return results
