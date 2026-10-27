import asyncio
import aiohttp
from typing import Dict, List, Any
from loguru import logger

class BybitCollector:
    def __init__(self):
        self.base_url = "https://api.bybit.com"
    
    async def get_tickers(self):
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{self.base_url}/v5/market/tickers?category=linear") as resp:
                data = await resp.json()
                return [d for d in data['result']['list'] if d['symbol'].endswith('USDT')]
    
    async def get_open_interest(self):
        tickers = await self.get_tickers()
        results = []
        async with aiohttp.ClientSession() as session:
            for ticker in tickers[:100]:
                try:
                    symbol = ticker['symbol']
                    results.append({
                        'venue': 'bybit',
                        'venue_symbol': symbol,
                        'base': symbol.replace('USDT', ''),
                        'oi_usd': float(ticker.get('openInterestValue', 0)),
                        'price': float(ticker['lastPrice']),
                        'vol24h_usd': float(ticker.get('turnover24h', 0))
                    })
                except Exception as e:
                    logger.error(f"Error processing Bybit {symbol}: {e}")
        return results
