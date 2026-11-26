// Starter figures for a new install. Written by the packaging script. General figures only: no prompts, names, paths or clients.

export type StarterRow = { n: number; p50: number; p90: number; max: number; mult: number | null }
/** `path`: the middle share of the work cost spent by 25%, 50% and 75% done, from 5 or more runs. */
export type StarterType = { n: number; p50: number; p90: number; max: number; maxFam: string; rows: Record<string, StarterRow>; subN: number; subP50: number; subP90: number; path?: { n: number; q: [number, number, number]; steps?: Record<string, number[]> } }

/** `start`: the median chat start in tokens by model family, the guess before the engine can count a chat. `startAll`: all models. */
export const STARTER: { from: string; subP90: number; start?: Record<string, number>; startAll?: number; types: Record<string, StarterType> } = {
  "from": "general figures from 686 real Claude Code tasks (2026-11-10 to 2026-11-17) and 769 real chat starts",
  "subP90": 2.2,
  "start": {
    "opus": 152260,
    "fable": 129383,
    "sonnet": 179098,
    "haiku": 101876
  },
  "startAll": 150883,
  "types": {
    "claude_tools": {
      "n": 495,
      "p50": 0.26,
      "p90": 1.63,
      "max": 170.67,
      "maxFam": "fable",
      "rows": {
        "opus high": {
          "n": 19,
          "p50": 0.53,
          "p90": 2.84,
          "max": 22.18,
          "mult": null
        },
        "opus medium": {
          "n": 40,
          "p50": 0.44,
          "p90": 0.93,
          "max": 1.16,
          "mult": null
        },
        "fable high": {
          "n": 22,
          "p50": 1.19,
          "p90": 3.45,
          "max": 46.25,
          "mult": null
        },
        "fable low": {
          "n": 20,
          "p50": 0.99,
          "p90": 2.45,
          "max": 4.1,
          "mult": null
        },
        "fable xhigh": {
          "n": 11,
          "p50": 7.71,
          "p90": 88.53,
          "max": 170.67,
          "mult": null
        },
        "opus low": {
          "n": 73,
          "p50": 0.51,
          "p90": 1.22,
          "max": 2.35,
          "mult": null
        },
        "sonnet low": {
          "n": 48,
          "p50": 0.25,
          "p90": 0.61,
          "max": 1.28,
          "mult": null
        },
        "haiku low": {
          "n": 90,
          "p50": 0.01,
          "p90": 0.19,
          "max": 0.36,
          "mult": null
        },
        "fable medium": {
          "n": 20,
          "p50": 1.53,
          "p90": 13.58,
          "max": 31.05,
          "mult": null
        },
        "haiku default": {
          "n": 10,
          "p50": 0.03,
          "p90": 0.08,
          "max": 0.08,
          "mult": null
        },
        "haiku medium": {
          "n": 45,
          "p50": 0.02,
          "p90": 0.02,
          "max": 0.25,
          "mult": null
        },
        "sonnet medium": {
          "n": 32,
          "p50": 0.23,
          "p90": 0.48,
          "max": 0.65,
          "mult": null
        },
        "sonnet high": {
          "n": 16,
          "p50": 0.43,
          "p90": 1.07,
          "max": 1.23,
          "mult": null
        },
        "haiku high": {
          "n": 14,
          "p50": 0.02,
          "p90": 0.22,
          "max": 0.28,
          "mult": null
        },
        "opus xhigh": {
          "n": 5,
          "p50": 0.8,
          "p90": 1.78,
          "max": 1.78,
          "mult": null
        },
        "sonnet xhigh": {
          "n": 5,
          "p50": 0.55,
          "p90": 1.41,
          "max": 1.41,
          "mult": null
        },
        "haiku xhigh": {
          "n": 5,
          "p50": 0.03,
          "p90": 0.35,
          "max": 0.35,
          "mult": null
        },
        "opus max": {
          "n": 5,
          "p50": 2.27,
          "p90": 4.12,
          "max": 4.12,
          "mult": null
        },
        "sonnet max": {
          "n": 5,
          "p50": 1.63,
          "p90": 2.15,
          "max": 2.15,
          "mult": null
        },
        "haiku max": {
          "n": 5,
          "p50": 0.16,
          "p90": 0.94,
          "max": 0.94,
          "mult": null
        },
        "fable max": {
          "n": 5,
          "p50": 4.64,
          "p90": 5.78,
          "max": 5.78,
          "mult": null
        }
      },
      "subN": 0,
      "subP50": 0,
      "subP90": 0,
      "path": {
        "n": 34,
        "q": [
          0.26,
          0.56,
          0.83
        ],
        "steps": {
          "3": [
            0.51,
            0.68,
            0.95
          ],
          "4": [
            0.13,
            0.48,
            0.97,
            0.86
          ],
          "5": [
            0.09,
            0.5,
            0.94,
            1,
            0.94
          ],
          "8": [
            0.6,
            -1,
            -1,
            -1,
            -1,
            -1,
            -1,
            -1
          ]
        }
      }
    },
    "video_media": {
      "n": 46,
      "p50": 3.32,
      "p90": 38.24,
      "max": 316.05,
      "maxFam": "fable",
      "rows": {
        "fable high": {
          "n": 26,
          "p50": 10.02,
          "p90": 102.96,
          "max": 316.05,
          "mult": null
        },
        "opus high": {
          "n": 6,
          "p50": 1.93,
          "p90": 5.21,
          "max": 5.21,
          "mult": null
        },
        "sonnet high": {
          "n": 1,
          "p50": 0.02,
          "p90": 0.02,
          "max": 0.02,
          "mult": null
        },
        "sonnet xhigh": {
          "n": 1,
          "p50": 0.04,
          "p90": 0.04,
          "max": 0.04,
          "mult": null
        },
        "sonnet low": {
          "n": 1,
          "p50": 0.02,
          "p90": 0.02,
          "max": 0.02,
          "mult": null
        },
        "fable low": {
          "n": 9,
          "p50": 0.83,
          "p90": 4.48,
          "max": 4.48,
          "mult": null
        },
        "opus medium": {
          "n": 2,
          "p50": 1.54,
          "p90": 1.54,
          "max": 1.54,
          "mult": null
        }
      },
      "subN": 14,
      "subP50": 1.18,
      "subP90": 2.2,
      "path": {
        "n": 8,
        "q": [
          0.23,
          0.53,
          0.77
        ],
        "steps": {
          "7": [
            0.28,
            0.72,
            0.72,
            0.72,
            0.72,
            0.81,
            0.93
          ],
          "10": [
            0.23,
            0.23,
            0.54,
            0.54,
            0.54,
            0.54,
            0.54,
            -1,
            -1,
            -1
          ]
        }
      }
    },
    "writing": {
      "n": 44,
      "p50": 6.35,
      "p90": 16.15,
      "max": 53.91,
      "maxFam": "opus",
      "rows": {
        "opus high": {
          "n": 25,
          "p50": 7.17,
          "p90": 22.98,
          "max": 53.91,
          "mult": null
        },
        "fable high": {
          "n": 9,
          "p50": 6.36,
          "p90": 16.15,
          "max": 16.15,
          "mult": null
        },
        "opus medium": {
          "n": 2,
          "p50": 8.29,
          "p90": 8.29,
          "max": 8.29,
          "mult": null
        },
        "sonnet medium": {
          "n": 1,
          "p50": 1.28,
          "p90": 1.28,
          "max": 1.28,
          "mult": null
        },
        "sonnet high": {
          "n": 2,
          "p50": 4.68,
          "p90": 4.68,
          "max": 4.68,
          "mult": null
        },
        "fable low": {
          "n": 1,
          "p50": 2.73,
          "p90": 2.73,
          "max": 2.73,
          "mult": null
        },
        "fable medium": {
          "n": 3,
          "p50": 0.74,
          "p90": 6.39,
          "max": 6.39,
          "mult": null
        },
        "haiku low": {
          "n": 1,
          "p50": 0.15,
          "p90": 0.15,
          "max": 0.15,
          "mult": 0.42
        }
      },
      "subN": 0,
      "subP50": 0,
      "subP90": 0,
      "path": {
        "n": 7,
        "q": [
          0.35,
          0.68,
          0.81
        ],
        "steps": {
          "3": [
            0.28,
            0.73,
            0.92
          ],
          "4": [
            0,
            0.14,
            0.51,
            0.73
          ]
        }
      }
    },
    "notes_docs": {
      "n": 29,
      "p50": 0.41,
      "p90": 3.86,
      "max": 8.03,
      "maxFam": "opus",
      "rows": {
        "opus high": {
          "n": 10,
          "p50": 2.61,
          "p90": 6.25,
          "max": 6.25,
          "mult": 2.15
        },
        "opus low": {
          "n": 2,
          "p50": 1.58,
          "p90": 1.58,
          "max": 1.58,
          "mult": null
        },
        "sonnet high": {
          "n": 5,
          "p50": 0.06,
          "p90": 0.13,
          "max": 0.13,
          "mult": null
        },
        "opus xhigh": {
          "n": 9,
          "p50": 0.07,
          "p90": 0.64,
          "max": 0.64,
          "mult": null
        },
        "opus medium": {
          "n": 2,
          "p50": 8.03,
          "p90": 8.03,
          "max": 8.03,
          "mult": 1.98
        },
        "haiku low": {
          "n": 1,
          "p50": 0.17,
          "p90": 0.17,
          "max": 0.17,
          "mult": 0.5
        }
      },
      "subN": 0,
      "subP50": 0,
      "subP90": 0
    },
    "design": {
      "n": 17,
      "p50": 1.1,
      "p90": 19.29,
      "max": 32.63,
      "maxFam": "fable",
      "rows": {
        "opus high": {
          "n": 10,
          "p50": 1.19,
          "p90": 4.52,
          "max": 4.52,
          "mult": null
        },
        "fable high": {
          "n": 2,
          "p50": 32.63,
          "p90": 32.63,
          "max": 32.63,
          "mult": null
        },
        "sonnet high": {
          "n": 2,
          "p50": 0.69,
          "p90": 0.69,
          "max": 0.69,
          "mult": null
        },
        "opus medium": {
          "n": 1,
          "p50": 0.38,
          "p90": 0.38,
          "max": 0.38,
          "mult": null
        },
        "haiku low": {
          "n": 1,
          "p50": 0.18,
          "p90": 0.18,
          "max": 0.18,
          "mult": null
        },
        "opus low": {
          "n": 1,
          "p50": 1.1,
          "p90": 1.1,
          "max": 1.1,
          "mult": null
        }
      },
      "subN": 0,
      "subP50": 0,
      "subP90": 0,
      "path": {
        "n": 5,
        "q": [
          0.18,
          0.51,
          0.74
        ],
        "steps": {
          "5": [
            0.42,
            0.42,
            0.6,
            0.69,
            0.91
          ]
        }
      }
    },
    "research": {
      "n": 14,
      "p50": 1.61,
      "p90": 9.72,
      "max": 40.92,
      "maxFam": "fable",
      "rows": {
        "opus high": {
          "n": 5,
          "p50": 0.64,
          "p90": 9.72,
          "max": 9.72,
          "mult": null
        },
        "fable high": {
          "n": 1,
          "p50": 40.92,
          "p90": 40.92,
          "max": 40.92,
          "mult": null
        },
        "opus medium": {
          "n": 6,
          "p50": 1.89,
          "p90": 2.16,
          "max": 2.16,
          "mult": 1.38
        },
        "sonnet medium": {
          "n": 1,
          "p50": 0.56,
          "p90": 0.56,
          "max": 0.56,
          "mult": null
        },
        "sonnet low": {
          "n": 1,
          "p50": 0.95,
          "p90": 0.95,
          "max": 0.95,
          "mult": 0.97
        }
      },
      "subN": 0,
      "subP50": 0,
      "subP90": 0,
      "path": {
        "n": 8,
        "q": [
          0.24,
          0.68,
          0.89
        ],
        "steps": {
          "3": [
            0,
            0.96,
            0.96
          ],
          "4": [
            0.13,
            0.31,
            0.31,
            0.96
          ]
        }
      }
    },
    "code": {
      "n": 11,
      "p50": 0.76,
      "p90": 3.22,
      "max": 4.49,
      "maxFam": "opus",
      "rows": {
        "opus high": {
          "n": 4,
          "p50": 3.22,
          "p90": 4.49,
          "max": 4.49,
          "mult": 1.22
        },
        "sonnet low": {
          "n": 3,
          "p50": 0.72,
          "p90": 0.76,
          "max": 0.76,
          "mult": null
        },
        "fable high": {
          "n": 1,
          "p50": 3.01,
          "p90": 3.01,
          "max": 3.01,
          "mult": null
        },
        "opus medium": {
          "n": 1,
          "p50": 1.47,
          "p90": 1.47,
          "max": 1.47,
          "mult": null
        },
        "haiku low": {
          "n": 1,
          "p50": 0.01,
          "p90": 0.01,
          "max": 0.01,
          "mult": null
        },
        "sonnet medium": {
          "n": 1,
          "p50": 0.09,
          "p90": 0.09,
          "max": 0.09,
          "mult": null
        }
      },
      "subN": 0,
      "subP50": 0,
      "subP90": 0
    },
    "inbox": {
      "n": 6,
      "p50": 0.79,
      "p90": 2.1,
      "max": 2.1,
      "maxFam": "opus",
      "rows": {
        "opus high": {
          "n": 3,
          "p50": 0.79,
          "p90": 1.14,
          "max": 1.14,
          "mult": null
        },
        "opus medium": {
          "n": 1,
          "p50": 2.1,
          "p90": 2.1,
          "max": 2.1,
          "mult": 0.76
        },
        "haiku low": {
          "n": 2,
          "p50": 0.22,
          "p90": 0.22,
          "max": 0.22,
          "mult": 0.96
        }
      },
      "subN": 0,
      "subP50": 0,
      "subP90": 0
    },
    "sales": {
      "n": 5,
      "p50": 1.85,
      "p90": 6.35,
      "max": 6.35,
      "maxFam": "opus",
      "rows": {
        "opus high": {
          "n": 2,
          "p50": 6.35,
          "p90": 6.35,
          "max": 6.35,
          "mult": null
        },
        "haiku medium": {
          "n": 1,
          "p50": 0.19,
          "p90": 0.19,
          "max": 0.19,
          "mult": null
        },
        "fable low": {
          "n": 1,
          "p50": 1.81,
          "p90": 1.81,
          "max": 1.81,
          "mult": null
        },
        "fable medium": {
          "n": 1,
          "p50": 1.85,
          "p90": 1.85,
          "max": 1.85,
          "mult": null
        }
      },
      "subN": 0,
      "subP50": 0,
      "subP90": 0
    },
    "other": {
      "n": 19,
      "p50": 0.73,
      "p90": 5.75,
      "max": 28.71,
      "maxFam": "sonnet",
      "rows": {
        "opus high": {
          "n": 6,
          "p50": 1.63,
          "p90": 5.75,
          "max": 5.75,
          "mult": 0.83
        },
        "sonnet high": {
          "n": 3,
          "p50": 0.57,
          "p90": 0.72,
          "max": 0.72,
          "mult": 0.66
        },
        "sonnet low": {
          "n": 2,
          "p50": 0.86,
          "p90": 0.86,
          "max": 0.86,
          "mult": null
        },
        "sonnet medium": {
          "n": 2,
          "p50": 0.92,
          "p90": 0.92,
          "max": 0.92,
          "mult": 1.28
        },
        "haiku low": {
          "n": 2,
          "p50": 0.01,
          "p90": 0.01,
          "max": 0.01,
          "mult": null
        },
        "haiku high": {
          "n": 1,
          "p50": 0.01,
          "p90": 0.01,
          "max": 0.01,
          "mult": null
        },
        "haiku medium": {
          "n": 1,
          "p50": 0.02,
          "p90": 0.02,
          "max": 0.02,
          "mult": null
        },
        "sonnet default": {
          "n": 1,
          "p50": 28.71,
          "p90": 28.71,
          "max": 28.71,
          "mult": null
        },
        "opus medium": {
          "n": 1,
          "p50": 2.02,
          "p90": 2.02,
          "max": 2.02,
          "mult": 1.04
        }
      },
      "subN": 0,
      "subP50": 0,
      "subP90": 0
    }
  }
}
