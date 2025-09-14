import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { jupiter_buy, jupiter_sell } from "../jupiter/adapter.js";
import { Notifications } from "../notifications/bus.js";
import { isDevBlacklisted } from "../safety/blacklist.js";
import { maxBuyForLiquidityUSD } from "../safety/liquidity.js";

interface ApiResponse {
  success: boolean;
  data?: any;
  error?: string;
  message?: string;
}

interface WalletInfo {
  address?: string;
  hasPrivateKey: boolean;
  balance?: number;
}

interface TradeRequest {
  mint: string;
  amount: number;
  slippage?: number;
  stop_loss?: number;
  take_profit?: number;
  priority_fee?: number;
}

interface WalletRequest {
  privateKey: string;
}

interface TxStatus {
  tx_hash: string;
  confirmed: boolean;
  slot?: number;
  error?: string;
  meta?: any;
}

class Logger {
  private logDir: string;
  private tradeLogFile: string;
  private errorLogFile: string;
  private accessLogFile: string;

  constructor() {
    this.logDir = path.join(process.cwd(), "logs");
    this.tradeLogFile = path.join(this.logDir, "trades.log");
    this.errorLogFile = path.join(this.logDir, "errors.log");
    this.accessLogFile = path.join(this.logDir, "access.log");

    this.ensureLogDir();
  }

  private ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
      console.log(`📂 Created logs directory: ${this.logDir}`);
    }
  }

  private writeToFile(file: string, entry: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${entry}\n`;
    fs.appendFileSync(file, line, "utf8");
  }

  logTrade(
    action: string,
    mint: string,
    amount: number,
    txHash?: string,
    confirmed?: boolean,
    error?: string
  ) {
    const status = error ? "FAILED" : "SUCCESS";
    const entry = `${action} ${status} token=${mint} amount=${amount} tx=${
      txHash || "N/A"
    } confirmed=${confirmed || false}${error ? ` ERROR=${error}` : ""}`;
    this.writeToFile(this.tradeLogFile, entry);
    console.log(`📝 Trade logged: ${entry}`);
  }

  logError(context: string, error: string) {
    const entry = `ERROR [${context}] ${error}`;
    this.writeToFile(this.errorLogFile, entry);
    console.error(`🚨 Error logged: ${entry}`);
  }

  logAccess(method: string, url: string, ip: string, statusCode: number) {
    const entry = `${method} ${url} ${ip} ${statusCode}`;
    this.writeToFile(this.accessLogFile, entry);
  }

  logWalletAction(action: string, address?: string, error?: string) {
    const entry = `WALLET ${action} address=${address || "N/A"}${
      error ? ` ERROR=${error}` : ""
    }`;
    this.writeToFile(this.tradeLogFile, entry);
    console.log(`🔑 Wallet action logged: ${entry}`);
  }
}

class SuperBotAPI {
  private currentWallet: string | null = null;
  private walletFile = path.join(process.cwd(), ".wallet.json");
  private logger = new Logger();
  private rpcUrl: string;

  constructor() {
    this.rpcUrl =
      process.env.RPC_URL ||
      process.env.SOLANA_RPC ||
      "https://api.mainnet-beta.solana.com";
    this.loadWallet();
    this.setupNotifications();
  }

  private loadWallet() {
    try {
      if (fs.existsSync(this.walletFile)) {
        const data = JSON.parse(fs.readFileSync(this.walletFile, "utf8"));
        this.currentWallet = data.privateKey;
        this.logger.logWalletAction("LOADED_FROM_FILE");
      } else if (process.env.WALLET_SECRET) {
        this.currentWallet = process.env.WALLET_SECRET;
        this.logger.logWalletAction("LOADED_FROM_ENV");
      } else {
        console.log("⚠️ No wallet configured");
      }
    } catch (error) {
      this.logger.logError("LOAD_WALLET", error.message);
    }
  }

  private saveWallet() {
    try {
      if (this.currentWallet) {
        fs.writeFileSync(
          this.walletFile,
          JSON.stringify({
            privateKey: this.currentWallet,
            updatedAt: new Date().toISOString(),
          })
        );
        this.logger.logWalletAction("SAVED");
      }
    } catch (error) {
      this.logger.logError("SAVE_WALLET", error.message);
    }
  }

  private setupNotifications() {
    Notifications.on((e) => {
      console.log(
        `[${e.level}] ${e.type} :: ${e.title}`,
        e.body || "",
        e.link || ""
      );
    });
  }

  // Check transaction status via RPC
  async checkTxStatus(txHash: string): Promise<TxStatus> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [txHash, { encoding: "json", commitment: "confirmed" }],
        }),
      });

      const data = await response.json();

      if (!data.result) {
        return {
          tx_hash: txHash,
          confirmed: false,
          error: "Transaction not found or not yet confirmed",
        };
      }

      return {
        tx_hash: txHash,
        confirmed: !!data.result.slot,
        slot: data.result.slot || null,
        meta: data.result.meta,
      };
    } catch (error) {
      return {
        tx_hash: txHash,
        confirmed: false,
        error: error.message,
      };
    }
  }

  // Buy endpoint with enhanced logging
  async executeBuy(
    mint: string,
    solAmount: number,
    slippageBps?: number,
    stopLoss?: number,
    takeProfit?: number,
    priorityFee?: number
  ): Promise<ApiResponse> {
    let txHash: string | undefined;

    try {
      console.log(`🛒 BUY REQUEST: ${solAmount} SOL for ${mint}`);

      // Validate wallet
      if (!this.currentWallet) {
        const error = "No wallet configured. Set wallet first.";
        this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
        return { success: false, error };
      }

      // Validate mint
      if (!mint || mint.length < 32) {
        const error = "Invalid mint address";
        this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
        return { success: false, error };
      }

      // Validate amount
      if (solAmount <= 0 || solAmount > 10) {
        const error = "Amount must be between 0 and 10 SOL";
        this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
        return { success: false, error };
      }

      // Safety checks
      const blacklistCheck = isDevBlacklisted("unknown");
      if (blacklistCheck.blocked) {
        const error = `Blacklisted: ${blacklistCheck.reason}`;
        this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
        return { success: false, error };
      }

      // Liquidity check
      const maxAllowed = maxBuyForLiquidityUSD(5000);
      const finalAmount = Math.min(solAmount, maxAllowed);

      if (finalAmount < solAmount) {
        console.log(
          `⚠️ Amount reduced from ${solAmount} to ${finalAmount} SOL due to liquidity limits`
        );
      }

      // Execute buy
      const result = await jupiter_buy(mint, finalAmount, slippageBps);
      txHash = result.txid;

      // Check transaction status
      let txStatus: TxStatus | null = null;
      if (txHash && txHash !== "TXID_BUY_STUB") {
        txStatus = await this.checkTxStatus(txHash);
      } else {
        // For stub implementation
        txStatus = { tx_hash: txHash || "STUB", confirmed: true };
      }

      // Log successful trade
      this.logger.logTrade(
        "BUY",
        mint,
        finalAmount,
        txHash,
        txStatus?.confirmed
      );

      Notifications.emit({
        type: "buy",
        level: "success",
        title: `BUY ${mint}`,
        body: `${finalAmount} SOL`,
        link: result.txid,
      });

      return {
        success: true,
        data: {
          txid: result.txid,
          mint,
          solAmount: finalAmount,
          price: result.price || 0,
          timestamp: new Date().toISOString(),
          tx_status: txStatus,
          stop_loss: stopLoss,
          take_profit: takeProfit,
          priority_fee: priorityFee,
        },
        message: `Successfully bought ${finalAmount} SOL worth of ${mint}`,
      };
    } catch (error) {
      this.logger.logTrade(
        "BUY",
        mint,
        solAmount,
        txHash,
        false,
        error.message
      );
      this.logger.logError("BUY_EXECUTION", error.message);
      return { success: false, error: error.message };
    }
  }

  // Sell endpoint with enhanced logging
  async executeSell(
    mint: string,
    tokenAmount: number,
    percentage?: number,
    slippageBps?: number
  ): Promise<ApiResponse> {
    let txHash: string | undefined;

    try {
      const sellAmount = tokenAmount;
      const sellPercent = percentage || 100;

      console.log(
        `💰 SELL REQUEST: ${sellAmount} tokens (${sellPercent}%) of ${mint}`
      );

      // Validate wallet
      if (!this.currentWallet) {
        const error = "No wallet configured. Set wallet first.";
        this.logger.logTrade(
          "SELL",
          mint,
          sellPercent,
          undefined,
          false,
          error
        );
        return { success: false, error };
      }

      // Validate mint
      if (!mint || mint.length < 32) {
        const error = "Invalid mint address";
        this.logger.logTrade(
          "SELL",
          mint,
          sellPercent,
          undefined,
          false,
          error
        );
        return { success: false, error };
      }

      // Validate amount
      if (sellAmount <= 0) {
        const error = "Token amount must be greater than 0";
        this.logger.logTrade(
          "SELL",
          mint,
          sellPercent,
          undefined,
          false,
          error
        );
        return { success: false, error };
      }

      // Execute sell
      const result = await jupiter_sell(mint, sellAmount, slippageBps);
      txHash = result.txid;

      // Check transaction status
      let txStatus: TxStatus | null = null;
      if (txHash && txHash !== "TXID_SELL_STUB") {
        txStatus = await this.checkTxStatus(txHash);
      } else {
        // For stub implementation
        txStatus = { tx_hash: txHash || "STUB", confirmed: true };
      }

      // Log successful trade
      this.logger.logTrade(
        "SELL",
        mint,
        sellPercent,
        txHash,
        txStatus?.confirmed
      );

      Notifications.emit({
        type: "sell",
        level: "success",
        title: `SELL ${mint}`,
        body: `${sellAmount} tokens (${sellPercent}%)`,
        link: result.txid,
      });

      return {
        success: true,
        data: {
          txid: result.txid,
          mint,
          tokenAmount: sellAmount,
          percentage: sellPercent,
          timestamp: new Date().toISOString(),
          tx_status: txStatus,
        },
        message: `Successfully sold ${sellAmount} tokens (${sellPercent}%) of ${mint}`,
      };
    } catch (error) {
      this.logger.logTrade(
        "SELL",
        mint,
        percentage || 100,
        txHash,
        false,
        error.message
      );
      this.logger.logError("SELL_EXECUTION", error.message);
      return { success: false, error: error.message };
    }
  }

  // Wallet management with logging
  async setWallet(privateKey: string): Promise<ApiResponse> {
    try {
      if (!privateKey || privateKey.length < 32) {
        const error = "Invalid private key format";
        this.logger.logWalletAction("SET_FAILED", undefined, error);
        return { success: false, error };
      }

      this.currentWallet = privateKey;
      this.saveWallet();

      const derivedAddress = "DERIVED_PUBLIC_KEY_HERE"; // In real impl, derive from private key
      this.logger.logWalletAction("SET_SUCCESS", derivedAddress);

      return {
        success: true,
        message: "Wallet updated successfully",
        data: {
          hasPrivateKey: true,
          address: derivedAddress,
        },
      };
    } catch (error) {
      this.logger.logWalletAction("SET_FAILED", undefined, error.message);
      this.logger.logError("SET_WALLET", error.message);
      return { success: false, error: error.message };
    }
  }

  async getWalletInfo(): Promise<ApiResponse> {
    try {
      const address = this.currentWallet
        ? "DERIVED_PUBLIC_KEY_HERE"
        : undefined;
      const info: WalletInfo = {
        hasPrivateKey: !!this.currentWallet,
        address,
        balance: this.currentWallet ? 1.234 : undefined,
      };

      return { success: true, data: info };
    } catch (error) {
      this.logger.logError("GET_WALLET_INFO", error.message);
      return { success: false, error: error.message };
    }
  }

  async removeWallet(): Promise<ApiResponse> {
    try {
      const address = this.currentWallet
        ? "DERIVED_PUBLIC_KEY_HERE"
        : undefined;
      this.currentWallet = null;

      if (fs.existsSync(this.walletFile)) {
        fs.unlinkSync(this.walletFile);
      }

      this.logger.logWalletAction("REMOVED", address);
      return { success: true, message: "Wallet removed successfully" };
    } catch (error) {
      this.logger.logError("REMOVE_WALLET", error.message);
      return { success: false, error: error.message };
    }
  }

  // Get transaction status
  async getTxStatus(txHash: string): Promise<ApiResponse> {
    try {
      const status = await this.checkTxStatus(txHash);
      return { success: true, data: status };
    } catch (error) {
      this.logger.logError("GET_TX_STATUS", error.message);
      return { success: false, error: error.message };
    }
  }

  // Get logs
  async getLogs(
    type: "trades" | "errors" | "access" = "trades",
    lines: number = 100
  ): Promise<ApiResponse> {
    try {
      let logFile: string;
      switch (type) {
        case "trades":
          logFile = this.logger["tradeLogFile"];
          break;
        case "errors":
          logFile = this.logger["errorLogFile"];
          break;
        case "access":
          logFile = this.logger["accessLogFile"];
          break;
        default:
          return { success: false, error: "Invalid log type" };
      }

      if (!fs.existsSync(logFile)) {
        return { success: true, data: { logs: [], message: "No logs found" } };
      }

      const content = fs.readFileSync(logFile, "utf8");
      const allLines = content.split("\n").filter((line) => line.trim());
      const recentLines = allLines.slice(-lines);

      return {
        success: true,
        data: {
          logs: recentLines,
          total: allLines.length,
          showing: recentLines.length,
        },
      };
    } catch (error) {
      this.logger.logError("GET_LOGS", error.message);
      return { success: false, error: error.message };
    }
  }

  getLogger() {
    return this.logger;
  }
}

// Helper functions
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function sendResponse(
  res: http.ServerResponse,
  data: ApiResponse,
  statusCode = 200
) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

function getClientIP(req: http.IncomingMessage): string {
  return (
    (req.headers["x-forwarded-for"] as string) ||
    (req.headers["x-real-ip"] as string) ||
    req.connection.remoteAddress ||
    "unknown"
  );
}

// Main server
const api = new SuperBotAPI();
const logger = api.getLogger();

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const clientIP = getClientIP(req);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    const url = req.url || "";
    const method = req.method || "GET";

    console.log(`📡 ${method} ${url} from ${clientIP}`);

    let statusCode = 200;
    let result: ApiResponse;

    // Buy endpoint
    if (method === "POST" && url === "/api/buy") {
      const body: TradeRequest = await parseBody(req);
      result = await api.executeBuy(
        body.mint,
        body.amount,
        body.slippage,
        body.stop_loss,
        body.take_profit,
        body.priority_fee
      );
      statusCode = result.success ? 200 : 400;
    }

    // Sell endpoint
    else if (method === "POST" && url === "/api/sell") {
      const body: TradeRequest & { percentage?: number } = await parseBody(req);
      result = await api.executeSell(
        body.mint,
        body.amount,
        body.percentage,
        body.slippage
      );
      statusCode = result.success ? 200 : 400;
    }

    // Set wallet
    else if (method === "POST" && url === "/api/wallet") {
      const body: WalletRequest = await parseBody(req);
      result = await api.setWallet(body.privateKey);
      statusCode = result.success ? 200 : 400;
    }

    // Get wallet info
    else if (method === "GET" && url === "/api/wallet") {
      result = await api.getWalletInfo();
    }

    // Remove wallet
    else if (method === "DELETE" && url === "/api/wallet") {
      result = await api.removeWallet();
    }

    // Get transaction status
    else if (method === "GET" && url.startsWith("/api/status/")) {
      const txHash = url.split("/")[3];
      result = await api.getTxStatus(txHash);
    }

    // Get logs
    else if (method === "GET" && url.startsWith("/api/logs")) {
      const urlParams = new URL(url, `http://localhost`);
      const type = (urlParams.searchParams.get("type") as any) || "trades";
      const lines = parseInt(urlParams.searchParams.get("lines") || "100");
      result = await api.getLogs(type, lines);
    }

    // 404
    else {
      result = { success: false, error: "Endpoint not found" };
      statusCode = 404;
    }

    sendResponse(res, result, statusCode);

    // Log access
    const duration = Date.now() - startTime;
    logger.logAccess(method, url, clientIP, statusCode);
    console.log(`✅ ${method} ${url} - ${statusCode} (${duration}ms)`);
  } catch (error) {
    console.error("❌ Server error:", error);
    const errorResult = { success: false, error: error.message };
    sendResponse(res, errorResult, 500);
    logger.logError("SERVER", error.message);
    logger.logAccess(req.method || "GET", req.url || "/", clientIP, 500);
  }
});

const PORT = process.env.API_PORT || 8001;
server.listen(PORT, () => {
  console.log(`🚀 SuperBot API running on http://localhost:${PORT}`);
  console.log(`📂 Logs directory: ${path.join(process.cwd(), "logs")}`);
});
