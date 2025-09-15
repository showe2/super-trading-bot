import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { jupiter_buy, jupiter_sell } from "../jupiter/adapter.js";
import { jito_buy } from "../jito/buy.js";
import { Notifications } from "../notifications/bus.js";
import { isDevBlacklisted } from "../safety/blacklist.js";
import { maxBuyForLiquidityUSD } from "../safety/liquidity.js";
import { Keypair, Connection } from "@solana/web3.js";
import bs58 from "bs58";

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

interface OnChainData {
  // Price data
  currentPriceUSD: number;

  // Liquidity data
  liquidityUSD: number;
  solReserve?: number;
  tokenReserve?: number;

  // Pool info
  poolExists: boolean;
  poolAddress?: string;
  dexType?: "raydium" | "pump" | "orca" | "jupiter";

  // Safety metrics
  volume24h: number;

  // Optional advanced data
  lpLocked?: boolean;
  topHolderPercent?: number;
  tokenTax?: number;
}

interface TradeRequest {
  mint: string;
  amount: number;
  slippage?: number;
  stop_loss?: number;
  take_profit?: number;
  priority_fee?: number;
  priority?: "normal" | "high";
  onChain?: OnChainData;
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
  private connection: Connection;

  constructor() {
    this.rpcUrl =
      process.env.RPC_URL ||
      process.env.SOLANA_RPC ||
      "https://api.mainnet-beta.solana.com";
    this.loadWallet();
    this.setupNotifications();
    this.connection = new Connection(this.rpcUrl, "confirmed");
  }

  private loadWallet() {
    try {
      let privateKeyString: string | null = null;

      if (fs.existsSync(this.walletFile)) {
        const data = JSON.parse(fs.readFileSync(this.walletFile, "utf8"));
        privateKeyString = data.privateKey;
      } else if (process.env.WALLET_SECRET) {
        privateKeyString = process.env.WALLET_SECRET;
      }

      if (privateKeyString) {
        this.currentWallet = privateKeyString;

        // Extract public key
        const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyString));
        const publicKey = keypair.publicKey.toString();

        this.logger.logWalletAction("LOADED_FROM_ENV", publicKey);
        console.log(`✅ Wallet loaded: ${publicKey}`);
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

  private calculateMaxBuyFromLiquidity(liquidityUSD: number): number {
    // Conservative liquidity-based position sizing
    if (liquidityUSD < 1000) return 0.05; // Very small pools
    if (liquidityUSD < 5000) return 0.1; // Small pools
    if (liquidityUSD < 20000) return 0.5; // Medium pools
    if (liquidityUSD < 100000) return 1.0; // Large pools
    return 2.0; // Very large pools
  }

  // Get wallet SOL balance
  private async getWalletSOLBalance(): Promise<number> {
    try {
      if (!this.currentWallet) {
        throw new Error("No wallet configured");
      }

      // Get public key from private key
      const keypair = Keypair.fromSecretKey(bs58.decode(this.currentWallet));
      const publicKey = keypair.publicKey;

      console.log(`🔍 Checking balance for: ${publicKey.toString()}`);

      // Get balance from Solana blockchain
      const balanceInLamports = await this.connection.getBalance(publicKey);
      const solBalance = balanceInLamports / 1e9; // Convert lamports to SOL

      console.log(`💰 Real SOL balance: ${solBalance}`);
      return solBalance;
    } catch (error) {
      console.error(`❌ Failed to get wallet balance:`, error.message);
      this.logger.logError("GET_WALLET_BALANCE", error.message);
      return 0;
    }
  }

  // Buy endpoint with enhanced logging and on-chain data
  async executeBuy(
    mint: string,
    solAmount: number,
    slippageBps?: number,
    stopLoss?: number,
    takeProfit?: number,
    priority?: string,
    priorityFee?: number,
    onChain?: OnChainData
  ): Promise<ApiResponse> {
    let txHash: string | undefined;

    try {
      console.log(`🛒 BUY REQUEST: ${solAmount} SOL for ${mint}`);

      // Apply default values
      const finalStopLoss = stopLoss ?? -20;
      const finalTakeProfit = takeProfit ?? 50;
      const finalPriorityFee = priorityFee ?? 0.00001;
      const finalSlippage = slippageBps ?? 150;

      console.log(
        `⚙️ Trading params: Stop Loss: ${finalStopLoss}%, Take Profit: ${finalTakeProfit}%, Priority Fee: ${finalPriorityFee} SOL, Slippage: ${finalSlippage}bps`
      );

      // Log on-chain data if provided
      if (onChain) {
        console.log(`📊 On-chain data provided:`);
        console.log(`   Price: $${onChain.currentPriceUSD}`);
        console.log(`   Liquidity: $${onChain.liquidityUSD}`);
        console.log(`   Volume 24h: $${onChain.volume24h}`);
        console.log(`   Pool exists: ${onChain.poolExists}`);
        console.log(`   DEX: ${onChain.dexType || "unknown"}`);
      }

      // Validate wallet
      if (!this.currentWallet) {
        const error = "No wallet configured. Set wallet first.";
        this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
        return { success: false, error };
      }

      // Check wallet balance
      console.log(`💰 Checking wallet balance...`);
      const walletBalance = await this.getWalletSOLBalance();
      console.log(`   Available SOL: ${walletBalance}`);

      if (walletBalance < solAmount) {
        const error = `Insufficient balance. Have ${walletBalance} SOL, need ${solAmount} SOL`;
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

      // Use on-chain data for safety checks if provided
      let finalAmount = solAmount;

      let priceImpact = 0;

      // Try Jupiter first (most accurate)
      priceImpact = await getPriceImpactFromJupiter(mint, finalAmount);

      // Fallback to calculation if Jupiter fails
      if (priceImpact === 0 && onChain?.solReserve && onChain?.tokenReserve) {
        priceImpact = calculatePriceImpact(
          onChain.solReserve,
          onChain.tokenReserve,
          finalAmount
        );
      }

      // Safety check
      if (priceImpact > 10) {
        throw new Error(`Price impact too high: ${priceImpact}% (max 10%)`);
      }

      if (onChain) {
        // Check if pool exists
        if (!onChain.poolExists) {
          const error = "No tradeable pool exists for this token";
          this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
          return { success: false, error };
        }

        // Apply liquidity-based position sizing
        const maxAllowed = this.calculateMaxBuyFromLiquidity(
          onChain.liquidityUSD
        );
        finalAmount = Math.min(solAmount, maxAllowed);

        if (finalAmount < solAmount) {
          console.log(
            `⚠️ Amount reduced from ${solAmount} to ${finalAmount} SOL due to liquidity limits`
          );
        }

        // Check token tax if provided
        if (onChain.tokenTax && onChain.tokenTax > 10) {
          const error = `Token tax too high: ${onChain.tokenTax}% (max 10%)`;
          this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
          return { success: false, error };
        }
      } else {
        // Fallback to old safety checks if no on-chain data
        console.log(
          `⚠️ No on-chain data provided, using fallback safety checks`
        );

        const blacklistCheck = isDevBlacklisted("unknown");
        if (blacklistCheck.blocked) {
          const error = `Blacklisted: ${blacklistCheck.reason}`;
          this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
          return { success: false, error };
        }

        const maxAllowed = maxBuyForLiquidityUSD(5000); // Fallback liquidity assumption
        finalAmount = Math.min(solAmount, maxAllowed);
      }

      // Execute buy
      let result;

      if (priority === "high") {
        console.log(`⚡ Using JITO for high-priority execution`);
        result = await jito_buy(
          mint,
          finalAmount,
          finalSlippage,
          finalPriorityFee
        );
      } else {
        console.log(`🔄 Using Jupiter for normal execution`);
        result = await jupiter_buy(
          mint,
          finalAmount,
          finalSlippage,
          finalPriorityFee
        );
      }

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
          stop_loss: finalStopLoss,
          take_profit: finalTakeProfit,
          priority_fee: finalPriorityFee,
          walletBalance: walletBalance,
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
    percentage?: number
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
      const result = await jupiter_sell(mint, sellAmount);
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
      let publicKey: string | undefined;
      let balance: number | undefined;

      if (this.currentWallet) {
        const keypair = Keypair.fromSecretKey(bs58.decode(this.currentWallet));
        publicKey = keypair.publicKey.toString();
        balance = await this.getWalletSOLBalance();
      }

      const info: WalletInfo = {
        hasPrivateKey: !!this.currentWallet,
        address: publicKey,
        balance: balance,
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

function calculatePriceImpact(
  solReserve: number,
  tokenReserve: number,
  solAmountIn: number
): number {
  // Constant Product Formula: x * y = k
  // Where x = SOL reserve, y = token reserve

  const k = solReserve * tokenReserve; // Constant product

  // After adding SOL, new reserves:
  const newSolReserve = solReserve + solAmountIn;
  const newTokenReserve = k / newSolReserve;

  // Tokens you get:
  const tokensOut = tokenReserve - newTokenReserve;

  // Price before trade:
  const priceBefore = solReserve / tokenReserve;

  // Price after trade (for remaining tokens):
  const priceAfter = newSolReserve / newTokenReserve;

  // Price impact percentage:
  const priceImpact = ((priceAfter - priceBefore) / priceBefore) * 100;

  console.log(`💥 Calculated price impact: ${priceImpact.toFixed(2)}%`);
  return priceImpact;
}

async function getPriceImpactFromJupiter(
  tokenMint: string,
  solAmount: number
): Promise<number> {
  try {
    const lamports = Math.floor(solAmount * 1e9); // Convert SOL to lamports

    const response = await fetch(
      `https://quote-api.jup.ag/v6/quote?` +
        `inputMint=So11111111111111111111111111111111111111112&` + // SOL mint
        `outputMint=${tokenMint}&` +
        `amount=${lamports}&` +
        `slippageBps=50`
    );

    if (!response.ok) {
      throw new Error(`Jupiter API failed: ${response.statusText}`);
    }

    const data = await response.json();

    // Jupiter returns price impact as string percentage
    const priceImpact = parseFloat(data.priceImpactPct || "0");

    console.log(`💥 Price impact for ${solAmount} SOL: ${priceImpact}%`);
    return priceImpact;
  } catch (error) {
    console.error("Failed to get price impact from Jupiter:", error);
    return 0; // Return 0 if can't calculate
  }
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
        body.priority,
        body.priority_fee,
        body.onChain
      );
      statusCode = result.success ? 200 : 400;
    }

    // Sell endpoint
    else if (method === "POST" && url === "/api/sell") {
      const body: TradeRequest & { percentage?: number } = await parseBody(req);
      result = await api.executeSell(body.mint, body.percentage);
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
