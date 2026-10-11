// Serves the OpenAPI spec at /api/openapi (rewritten from /api/openapi.json
// and /openapi.json, the x402scan discovery location).
const SPEC = {
 "info": {
  "title": "Flow API",
  "version": "0.3.0",
  "description": "Best-execution swap quotes, contract safety verification, and smart-wallet signals for AI agents on Base. The quote engine compares Uniswap V3, PancakeSwap V3 and Aerodrome across fee tiers, plus two-hop routes via WETH, and answers in ~100ms. Pay-per-call via x402 on Base (quotes $0.01, safety verdicts $0.02) \u2014 no API key, no account.",
  "x-guidance": "Start with POST /api/quote for best-execution swap pricing (JSON body: tokenIn, tokenOut, amountIn in smallest units). Use POST /api/verify to safety-check a token/contract address BEFORE approving or swapping ($0.02/call). POST /api/precheck is a free combined quote+safety check. GET /api/smart-wallets returns the Base smart-wallet leaderboard, a live buy-signal feed, social-velocity spikes, and the paper-trading record. GET /api/signals is the polling feed behind it: chronological buy signals + social-velocity spikes, newest first, each with timestamp + block number + wallet + token + signal score, with incremental polling via ?since=<unix timestamp or block number> ($0.01/call). Paid endpoints return HTTP 402 with an x402 v2 payment challenge when unpaid; payTo is a Base wallet, asset is USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), network eip155:8453.",
  "contact": {
   "email": "Flowexecutor@yahoo.com"
  }
 },
 "openapi": "3.0.3",
 "paths": {
  "/api/health": {
   "get": {
    "responses": {
     "200": {
      "content": {
       "application/json": {
        "schema": {
         "properties": {
          "blockNumber": {
           "type": "integer"
          },
          "chain": {
           "type": "string"
          },
          "status": {
           "type": "string"
          }
         },
         "type": "object"
        }
       }
      },
      "description": "Healthy"
     }
    },
    "summary": "Service health"
   }
  },
  "/api/quote": {
   "post": {
    "description": "Returns the best available price across Uniswap V3, PancakeSwap V3 and Aerodrome (including two-hop routes via WETH) for a token swap on Base, plus the edge in basis points over the Uniswap baseline.",
    "requestBody": {
     "content": {
      "application/json": {
       "schema": {
        "properties": {
         "amountIn": {
          "description": "Input amount in smallest units",
          "example": "1000000",
          "type": "string"
         },
         "tokenIn": {
          "description": "ERC-20 contract address of input token",
          "example": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "type": "string"
         },
         "tokenInDecimals": {
          "default": 6,
          "description": "Decimals of input token",
          "type": "integer"
         },
         "tokenOut": {
          "description": "ERC-20 contract address of output token",
          "example": "0x4200000000000000000000000000000000000006",
          "type": "string"
         }
        },
        "required": [
         "tokenIn",
         "tokenOut",
         "amountIn"
        ],
        "type": "object"
       }
      }
     },
     "required": true
    },
    "responses": {
     "200": {
      "content": {
       "application/json": {
        "schema": {
         "properties": {
          "bestOut": {
           "description": "Best output amount in smallest units",
           "type": "string"
          },
          "edgeBps": {
           "description": "Edge over Uniswap baseline in basis points",
           "type": "number"
          },
          "uniswapOut": {
           "description": "Uniswap V3 output for comparison",
           "type": "string"
          },
          "venue": {
           "description": "Winning DEX",
           "enum": [
            "uniswap",
            "aerodrome"
           ],
           "type": "string"
          }
         },
         "type": "object"
        }
       }
      },
      "description": "Best quote"
     },
     "402": {
      "description": "Payment required \u2014 x402 v2 exact, $0.01 USDC on Base (eip155:8453)."
     }
    },
    "summary": "Get best swap price",
    "x-payment-info": {
     "price": {
      "mode": "fixed",
      "currency": "USD",
      "amount": "0.010000"
     },
     "protocols": [
      {
       "x402": {}
      }
     ]
    }
   }
  },
  "/api/stats": {
   "get": {
    "description": "Approximate per-instance counters (reset on cold start).",
    "responses": {
     "200": {
      "content": {
       "application/json": {
        "schema": {
         "properties": {
          "errors": {
           "type": "integer"
          },
          "instanceStarted": {
           "format": "date-time",
           "type": "string"
          },
          "quotesServed": {
           "type": "integer"
          }
         },
         "type": "object"
        }
       }
      },
      "description": "Stats snapshot"
     }
    },
    "summary": "Usage statistics"
   }
  },
  "/api/verify": {
   "post": {
    "description": "Contract safety check for AI agents: verifies whether a contract's source is published, detects upgradeable proxies, scans verified source for dangerous owner privileges (mint/pause/blacklist/taxes), checks ownership, and simulates a buy+sell to catch honeypots. Returns a plain-English risk report with a safe/caution/danger verdict.",
    "requestBody": {
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "address": {
          "type": "string",
          "description": "Contract address to check (0x + 40 hex chars). 'token' is accepted as an alias.",
          "example": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
         },
         "chain": {
          "type": "string",
          "description": "Chain name or chain id. Default: base.",
          "default": "base",
          "example": "base"
         }
        },
        "required": [
         "address"
        ]
       }
      }
     },
     "required": true
    },
    "responses": {
     "200": {
      "description": "Risk report",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "properties": {
          "verdict": {
           "type": "string",
           "enum": [
            "safe",
            "caution",
            "danger"
           ],
           "description": "Overall verdict."
          },
          "score": {
           "type": "integer",
           "description": "0-100, starts at 100 with deductions per red flag."
          },
          "agentAdvice": {
           "type": "string",
           "enum": [
            "APPROVE",
            "REVIEW_MANUALLY",
            "DO_NOT_APPROVE"
           ]
          },
          "summary": {
           "type": "string",
           "description": "Plain-English risk report, 2-4 sentences."
          },
          "flags": {
           "type": "array",
           "items": {
            "type": "object",
            "properties": {
             "severity": {
              "type": "string",
              "enum": [
               "critical",
               "high",
               "medium",
               "low",
               "info"
              ]
             },
             "text": {
              "type": "string"
             }
            }
           }
          },
          "details": {
           "type": "object",
           "description": "Full check results: sourceVerified, proxy, owner, privileges, honeypot simulation."
          }
         }
        }
       }
      }
     },
     "400": {
      "description": "Invalid address or chain."
     },
     "405": {
      "description": "POST only."
     },
     "402": {
      "description": "Payment required \u2014 x402 v2 exact, $0.01 USDC on Base (eip155:8453)."
     }
    },
    "x-payment-info": {
     "price": {
      "mode": "fixed",
      "currency": "USD",
      "amount": "0.020000"
     },
     "protocols": [
      {
       "x402": {}
      }
     ]
    }
   }
  },
  "/api/smart-wallets": {
   "get": {
    "description": "Smart-wallet tracker for Base: leaderboard of wallets ranked by early buys on pumping tokens, a real-time buy-signal feed (each signal carries timestamp + block number; signals older than 10 min are flagged stale), a social-velocity overlay (DexScreener boost acceleration + GeckoTerminal trending rank, raw inputs included), and a PAPER paper-trading record that copy-trades top wallets with $50 simulated positions. x402 pay-per-call: $0.01 USDC on Base.",
    "responses": {
     "200": {
      "description": "Leaderboard (top 20), signals (latest 20), paperRecord, methodology, dataAsOf, source, disclaimer.",
      "content": {
       "application/json": {
        "schema": {
         "type": "object"
        }
       }
      }
     },
     "402": {
      "description": "Payment required \u2014 x402 v2 exact, $0.01 USDC on Base (eip155:8453)."
     },
     "503": {
      "description": "Tracker has not produced data yet."
     }
    },
    "x-payment-info": {
     "price": {
      "mode": "fixed",
      "currency": "USD",
      "amount": "0.010000"
     },
     "protocols": [
      {
       "x402": {}
      }
     ]
    }
   }
  },
  "/api/signals": {
   "get": {
    "description": "Use when an agent is polling for fresh smart-wallet buy signals on Base and needs only what's new since its last check. Chronological signal feed: recent buy signals from tracked Base wallets plus social-velocity spikes, newest first, every entry with timestamp, block number, wallet, token, and a labeled signal score. Supports incremental polling via ?since=<unix seconds, unix ms, ISO 8601, or Base block number> and ?limit=<1..100> (default 50). x402 pay-per-call: $0.01 USDC on Base.",
    "parameters": [
     {
      "name": "since",
      "in": "query",
      "required": false,
      "description": "Only return entries strictly newer than this: unix seconds (>=1e9), unix milliseconds (>=1e12), an ISO 8601 timestamp, or a Base block number (<1e9).",
      "schema": { "type": "string" }
     },
     {
      "name": "limit",
      "in": "query",
      "required": false,
      "description": "Max signals to return, 1..100 (default 50).",
      "schema": { "type": "integer" }
     }
    ],
    "responses": {
     "200": {
      "description": "signals (newest first), socialSpikes, returned/available counts, cursor for the next poll, dataAsOf, source, scoreMethod, disclaimer.",
      "content": {
       "application/json": {
        "schema": {
         "type": "object"
        }
       }
      }
     },
     "402": {
      "description": "Payment required \u2014 x402 v2 exact, $0.01 USDC on Base (eip155:8453)."
     },
     "503": {
      "description": "Tracker has not produced data yet."
     }
    },
    "x-payment-info": {
     "price": {
      "mode": "fixed",
      "currency": "USD",
      "amount": "0.010000"
     },
     "protocols": [
      {
       "x402": {}
      }
     ]
    }
   }
  },
  "/api/precheck": {
   "post": {
    "summary": "Free combined quote + safety precheck",
    "description": "Free pre-trade check: best-execution quote plus a safety verdict for the output token in one call (verdict safe|caution|danger, score 0-100, safeToProceed). No payment required.",
    "requestBody": {
     "required": true,
     "content": {
      "application/json": {
       "schema": {
        "type": "object",
        "properties": {
         "tokenIn": {
          "type": "string",
          "example": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
         },
         "tokenOut": {
          "type": "string",
          "example": "0x4200000000000000000000000000000000000006"
         },
         "amountIn": {
          "type": "string",
          "example": "1000000"
         }
        },
        "required": [
         "tokenIn",
         "tokenOut",
         "amountIn"
        ]
       }
      }
     }
    },
    "responses": {
     "200": {
      "description": "Quote + safety verdict",
      "content": {
       "application/json": {
        "schema": {
         "type": "object"
        }
       }
      }
     },
     "400": {
      "description": "Missing tokenIn, tokenOut, or amountIn."
     }
    }
   }
  }
 },
 "servers": [
  {
   "url": "https://flow-kg4x.vercel.app"
  }
 ]
};
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).send(JSON.stringify(SPEC));
};
