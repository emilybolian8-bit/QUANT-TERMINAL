import asyncio
import aiohttp
from typing import Dict, List, Any
from loguru import logger

class OkxCollector:
    def __init__(self):
        self.base_url = "https://www.okx.com"
    
    async def get_tickers(self):
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{self.base_url}/api/v5/market/tickers?instType=SWAP") as resp:
                data = await resp.json()
                return [d for d in data['data'] if d['instId'].endswith('-USDT-SWAP')]
    
    async def get_open_interest(self):
        tickers = await self.get_tickers()
        results = []
        async with aiohttp.ClientSession() as session:
            for ticker in tickers[:100]:
                try:
                    inst_id = ticker['instId']
                    base = inst_id.replace('-USDT-SWAP', '')
                    # Get OI
                    async with session.get(f"{self.base_url}/api/v5/public/open-interest?instId={inst_id}") as resp:
                        oi_data = await resp.json()
                        oi_val = 0
                        if oi_data['data']:
                            # OKX returns OI in contracts, need contract value
                            oi_val = float(oi_data['data'][0]['oi']) * float(ticker['last'])
                    results.append({
                        'venue': 'okx',
                        'venue_symbol': inst_id,
                        'base': base,
                        'oi_usd': oi_val,
                        'price': float(ticker['last']),
                        'vol24h_usd': float(ticker['volCcy24h'])
                    })
                except Exception as e:
                    logger.error(f"Error processing OKX {inst_id}: {e}")
        return results
