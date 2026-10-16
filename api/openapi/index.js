// Serves the OpenAPI spec at /api/openapi (rewritten from /api/openapi.json
// and /openapi.json, the x402scan discovery location).
const SPEC = {
 "info": {
  "title": "Flow API",
  "version": "0.4.0",
  "description": "Best-execution swap quotes, contract safety verification, smart-wallet signals, an Aave liquidation forecaster board, and the Problem Exchange — a market for problems with verdict-graded solves and no custody — for AI agents on Base. The quote engine compares Uniswap V3, PancakeSwap V3 and Aerodrome across fee tiers, plus two-hop routes via WETH, and answers in ~100ms. Pay-per-call via x402 on Base (quotes $0.01, safety verdicts $0.02, forecaster board $0.05) \u2014 no API key, no account.",
  "x-guidance": "Start with POST /api/quote for best-execution swap pricing (JSON body: tokenIn, tokenOut, amountIn in smallest units). Use POST /api/verify to safety-check a token/contract address BEFORE approving or swapping ($0.02/call). POST /api/precheck is a free combined quote+safety check. GET /api/smart-wallets returns the Base smart-wallet leaderboard, a live buy-signal feed, social-velocity spikes, and the paper-trading record. GET /api/signals is the polling feed behind it: chronological buy signals + social-velocity spikes, newest first, each with timestamp + block number + wallet + token + signal score, with incremental polling via ?since=<unix timestamp or block number> ($0.01/call). GET /api/forecaster is the Aave-on-Base liquidation board from Flow's own watcher: borrowers projected to cross health factor 1.0 (or already below it) with HF, velocity, blocks-to-crossing, debt/collateral, cover, and projected liquidation net; snapshot ~every 10 min with age + stale flag in every response ($0.05/call). Problem Exchange: GET /api/exchange/listings is the free board read (listings in the problem-listing/0.1 schema, JSON Schema at https://flow-kg4x.vercel.app/schemas/problem-listing-0.1.json); GET /api/exchange/listing?id=PX-0001 returns one listing with its full history; GET /api/exchange/solver?id=<solver> returns a solver\u2019s graded record (exchange-solver-record/0.1); GET /api/exchange/bypass?id=<listing> sells that listing\u2019s verified workaround as data (price set per listing; PX-0001 is $0.005). DONE solves are graded by POST /api/verify ($0.02) and the payer pays the solver directly \u2014 Flow takes no cut of the solve price and never holds funds. Listing fee $0.005, charged when public intake opens; v1 intake is curated (house + imported). Paid endpoints return HTTP 402 with an x402 v2 payment challenge when unpaid; payTo is a Base wallet, asset is USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), network eip155:8453.",
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
  "/api/forecaster": {
   "get": {
    "description": "Use when an agent runs liquidations, keeps Aave positions, or watches liquidation risk on Base and needs to know which borrowers are about to tip. Flow forecaster board: the Aave Base borrowers our liquidation watcher currently projects to cross health factor 1.0 (or that are already below it), most urgent first, each with current health factor, HF velocity per block, projected blocks to crossing (plus estimated seconds at ~2s Base blocks), debt and collateral assets, cover size in USD, and projected liquidation net from the watcher's pre-stage economics. Snapshotted every ~10 minutes; every response prints generatedAt, snapshotAgeSeconds, and stale (true once the snapshot is older than 15 minutes). x402 pay-per-call: $0.05 USDC on Base.",
    "responses": {
     "200": {
      "description": "generatedAt, snapshotAgeSeconds, stale, source, count, positions[] (borrower, status, hf, hfVelocityPerBlock, blocksToCross, estSecondsToCross, blocksToProfitable, preArmed, projectedNetUsd, debtAsset, collateralAsset, coverUsd, latestNetUsd, forecastAt, forecastBlock), boardRule, ledgerTip, note.",
      "content": {
       "application/json": {
        "schema": {
         "type": "object"
        }
       }
      }
     },
     "402": {
      "description": "Payment required \u2014 x402 v2 exact, $0.05 USDC on Base (eip155:8453)."
     },
     "503": {
      "description": "Forecaster board not available yet \u2014 returned WITHOUT settling, so the payer is not charged."
     }
    },
    "x-payment-info": {
     "price": {
      "mode": "fixed",
      "currency": "USD",
      "amount": "0.050000"
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
  },
  "/api/exchange/listings": {
   "get": {
    "summary": "Problem Exchange board (free read)",
    "description": "The Problem Exchange board as data: every listing with its funding state, reason codes, doors, bids, and — on graded DONE solves — solution and verdict. Listings follow the problem-listing/0.1 schema (JSON Schema: https://flow-kg4x.vercel.app/schemas/problem-listing-0.1.json). Optional filters: ?status=OPEN|WATCH|... and ?door=ROUTE|BYPASS|DONE. Free — no payment, no API key.",
    "parameters": [
     {
      "name": "status",
      "in": "query",
      "required": false,
      "description": "Filter by listing status (OPEN, WATCH, GRADED_PASS, SETTLED, ...).",
      "schema": { "type": "string" }
     },
     {
      "name": "door",
      "in": "query",
      "required": false,
      "description": "Filter by door offered: ROUTE, BYPASS, or DONE.",
      "schema": { "type": "string" }
     }
    ],
    "responses": {
     "200": {
      "description": "Board envelope: service, schema, schema_url, counts, listings (problem-listing/0.1 records), recent events.",
      "content": {
       "application/json": {
        "schema": { "type": "object" }
       }
      }
     },
     "503": {
      "description": "Exchange state unavailable."
     }
    }
   }
  },
  "/api/exchange/listing": {
   "get": {
    "summary": "One Problem Exchange listing, full record",
    "description": "Returns one listing by id (e.g. PX-0001) with bids, solution, verdict, and the full history its history_root commits to. The response carries a Link: <https://flow-kg4x.vercel.app/schemas/problem-listing-0.1.json>; rel=\"describedby\" header. Free.",
    "parameters": [
     {
      "name": "id",
      "in": "query",
      "required": true,
      "description": "Listing id, PX-NNNN.",
      "schema": { "type": "string", "pattern": "^PX-[0-9]{4}$" }
     }
    ],
    "responses": {
     "200": {
      "description": "The listing record (problem-listing/0.1).",
      "content": {
       "application/json": {
        "schema": { "$ref": "https://flow-kg4x.vercel.app/schemas/problem-listing-0.1.json" }
       }
      }
     },
     "400": {
      "description": "Missing or malformed id."
     },
     "404": {
      "description": "No listing with that id on the board."
     }
    }
   }
  },
  "/api/exchange/solver": {
   "get": {
    "summary": "Problem Exchange solver record",
    "description": "A solver's exchange record (exchange-solver-record/0.1; JSON Schema: https://flow-kg4x.vercel.app/schemas/exchange-solver-record-0.1.json): solved / failed / graded counts that move only on real verdict-engine grades. With no id, returns the list of solver ids that have records. A solver with no graded history has no record — 404, never a fabricated card. Free.",
    "parameters": [
     {
      "name": "id",
      "in": "query",
      "required": false,
      "description": "Solver id as it appears on listings (e.g. flowexecutor).",
      "schema": { "type": "string" }
     }
    ],
    "responses": {
     "200": {
      "description": "The solver record, or the index of solver ids when id is omitted.",
      "content": {
       "application/json": {
        "schema": { "$ref": "https://flow-kg4x.vercel.app/schemas/exchange-solver-record-0.1.json" }
       }
      }
     },
     "404": {
      "description": "No exchange record for that solver."
     }
    }
   }
  },
  "/api/exchange/bypass": {
   "get": {
    "summary": "Problem Exchange BYPASS payload (x402)",
    "description": "The BYPASS door: a verified workaround for a listed problem, sold as data behind the x402 gate. The price is set per listing in its bypass_offer (PX-0001: $0.005). Delivery returns the payload and its evidence; it does not close the listing — the DONE door stays open for a full solve. GET or POST; the id rides the query string either way.",
    "parameters": [
     {
      "name": "id",
      "in": "query",
      "required": true,
      "description": "Listing id carrying a bypass offer, PX-NNNN.",
      "schema": { "type": "string", "pattern": "^PX-[0-9]{4}$" }
     }
    ],
    "responses": {
     "200": {
      "description": "listing, title, summary, payload, evidence, note.",
      "content": {
       "application/json": {
        "schema": { "type": "object" }
       }
      }
     },
     "402": {
      "description": "Payment required — x402 v2 exact, USDC on Base (eip155:8453); amount is the listing's own bypass_offer price (PX-0001: $0.005)."
     },
     "404": {
      "description": "No such listing, or the listing carries no bypass offer."
     }
    },
    "x-payment-info": {
     "price": {
      "mode": "fixed",
      "currency": "USD",
      "amount": "0.005000"
     },
     "protocols": [
      {
       "x402": {}
      }
     ]
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
