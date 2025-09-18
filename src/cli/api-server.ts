import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { jupiter_buy, jupiter_sell } from "../jupiter/adapter.js";
import { jito_buy } from "../jito/buy.js";
import { Notifications } from "../notifications/bus.js";
import { isDevBlacklisted } from "../safety/blacklist.js";
import { maxBuyForLiquidityUSD } from "../safety/liquidity.js";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { transactionRepo } from "../database/repositories/TransactionRepository.js";
import { OnChainData } from "../database/entities/Transaction.js";

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
  priority?: "normal" | "high";
  onChain: OnChainData;
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
        const keypair = Keypair.fromSecretKey(bs58.decode(this.currentWallet));
        const publicKey = keypair.publicKey.toString();

        fs.writeFileSync(
          this.walletFile,
          JSON.stringify({
            privateKey: this.currentWallet,
            updatedAt: new Date().toISOString(),
          })
        );

        this.logger.logWalletAction("SAVED", publicKey);
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
      console.log(`🔍 Checking transaction status for: ${txHash}`);

      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [
            txHash,
            {
              encoding: "json",
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0, // ← Add this line
            },
          ],
        }),
      });

      const data = await response.json();

      if (data.error) {
        console.log(`❌ RPC Error: ${data.error.message}`);
        return {
          tx_hash: txHash,
          confirmed: false,
          error: data.error.message,
        };
      }

      if (!data.result) {
        console.log(`❌ No result found for transaction: ${txHash}`);
        return {
          tx_hash: txHash,
          confirmed: false,
          error: "Transaction not found or not yet confirmed",
        };
      }

      const isConfirmed = !!data.result.slot;
      console.log(
        `✅ Transaction status: confirmed=${isConfirmed}, slot=${data.result.slot}`
      );

      return {
        tx_hash: txHash,
        confirmed: isConfirmed,
        slot: data.result.slot || null,
        meta: data.result.meta,
      };
    } catch (error) {
      console.error(`❌ Error checking transaction status:`, error);
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

  private calculatePriceImpact(
    solReserve: number,
    tokenReserve: number,
    solAmountIn: number
  ): number {
    try {
      if (solReserve <= 0 || tokenReserve <= 0 || solAmountIn <= 0) {
        return 0;
      }

      // Constant Product Formula: x * y = k
      const k = solReserve * tokenReserve;

      // After adding SOL, new reserves:
      const newSolReserve = solReserve + solAmountIn;
      const newTokenReserve = k / newSolReserve;

      // Price before trade:
      const priceBefore = solReserve / tokenReserve;

      // Price after trade:
      const priceAfter = newSolReserve / newTokenReserve;

      // Price impact percentage:
      const priceImpact = ((priceAfter - priceBefore) / priceBefore) * 100;

      return Math.abs(priceImpact);
    } catch (error) {
      console.error("Failed to calculate price impact:", error.message);
      return 0;
    }
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
    priorityFee?: number,
    priority?: "normal" | "high",
    onChain?: OnChainData
  ): Promise<ApiResponse> {
    let txHash: string | undefined;
    let walletPublicKey: string | undefined;
    let calculatedPriceImpact = 0;

    // Apply default values
    const finalStopLoss = stopLoss ?? -20;
    const finalTakeProfit = takeProfit ?? 50;
    const finalPriorityFee = priorityFee ?? 0.00001;
    const finalSlippage = Math.floor(slippageBps * 100) ?? 150;

    try {
      console.log(`🛒 BUY REQUEST: ${solAmount} SOL for ${mint}`);
      console.log(
        `⚙️ Trading params: Stop Loss: ${finalStopLoss}%, Take Profit: ${finalTakeProfit}%, Priority Fee: ${finalPriorityFee} SOL, Slippage: ${finalSlippage}%`
      );

      // Log received on-chain data
      if (onChain) {
        console.log(`📊 On-chain data received:`);
        console.log(`   Price: $${onChain.currentPriceUSD}`);
        console.log(`   Liquidity: $${onChain.liquidityUSD}`);
        console.log(`   Volume 24h: $${onChain.volume24h}`);
        console.log(`   Pool exists: ${onChain.poolExists}`);
        console.log(`   DEX: ${onChain.dexType}`);
        console.log(`   Token: ${onChain.symbol} (${onChain.name})`);
        if (onChain.whales1h) {
          console.log(
            `   Whales 1h: ${onChain.whales1h.whaleCount} whales, risk: ${onChain.whales1h.whaleRisk}`
          );
        }
      }

      // Validate wallet
      if (!this.currentWallet) {
        const error = "No wallet configured. Set wallet first.";
        this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
        return { success: false, error };
      }

      // Get wallet public key
      const keypair = Keypair.fromSecretKey(bs58.decode(this.currentWallet));
      walletPublicKey = keypair.publicKey.toString();

      // Check wallet balance
      console.log(`💰 Checking wallet balance...`);
      const walletBalance = await this.getWalletSOLBalance();
      console.log(`   Available SOL: ${walletBalance}`);

      if (walletBalance < solAmount) {
        const error = `Insufficient balance. Have ${walletBalance} SOL, need ${solAmount} SOL`;
        this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
        return { success: false, error };
      }

      // Validate mint and amount
      if (!mint || mint.length < 32) {
        const error = "Invalid mint address";
        this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
        return { success: false, error };
      }

      if (solAmount <= 0 || solAmount > 10) {
        const error = "Amount must be between 0 and 10 SOL";
        this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
        return { success: false, error };
      }

      // Use on-chain data for safety checks
      let finalAmount = solAmount;

      if (onChain) {
        // Check if pool exists
        if (!onChain.poolExists) {
          const error = "No tradeable pool exists for this token";
          this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
          return { success: false, error };
        }

        // Apply liquidity-based position sizing
        if (onChain.liquidityUSD > 0) {
          const maxAllowed = this.calculateMaxBuyFromLiquidity(
            onChain.liquidityUSD
          );
          finalAmount = Math.min(solAmount, maxAllowed);

          if (finalAmount < solAmount) {
            console.log(
              `⚠️ Amount reduced from ${solAmount} to ${finalAmount} SOL due to liquidity limits`
            );
          }
        }

        // Calculate price impact if we have reserve data
        if (
          onChain.solReserve &&
          onChain.tokenReserve &&
          onChain.solReserve > 0 &&
          onChain.tokenReserve > 0
        ) {
          calculatedPriceImpact = this.calculatePriceImpact(
            onChain.solReserve,
            onChain.tokenReserve,
            finalAmount
          );
          console.log(
            `   Price Impact: ${calculatedPriceImpact.toFixed(2)}% (calculated)`
          );

          // Safety check
          if (calculatedPriceImpact > 10) {
            const error = `Price impact too high: ${calculatedPriceImpact.toFixed(
              2
            )}% (max 10%)`;
            this.logger.logTrade(
              "BUY",
              mint,
              finalAmount,
              undefined,
              false,
              error
            );
            return { success: false, error };
          }
        } else {
          console.log(
            `   Price Impact: Cannot calculate (missing reserve data)`
          );
        }

        // Check token tax
        if (onChain.tokenTax && onChain.tokenTax > 10) {
          const error = `Token tax too high: ${onChain.tokenTax}% (max 10%)`;
          this.logger.logTrade("BUY", mint, solAmount, undefined, false, error);
          return { success: false, error };
        }

        // Check whale risk
        if (onChain.whales1h && onChain.whales1h.whaleRisk === "high") {
          console.log(`⚠️ Warning: High whale risk detected`);
        }
      }

      // Route to appropriate trading method
      let result;
      if (priority === "high") {
        const isDevnet = this.rpcUrl.includes("devnet");

        if (isDevnet) {
          console.log(
            `⚠️ Jito not available on devnet, using Jupiter with high priority fee`
          );
          const highPriorityFee = finalPriorityFee * 10;
          result = await jupiter_buy(
            mint,
            finalAmount,
            finalSlippage,
            highPriorityFee
          );
        } else {
          console.log(`⚡ Using JITO for high-priority execution`);
          result = await jito_buy(
            mint,
            finalAmount,
            finalSlippage,
            finalPriorityFee
          );
        }
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

      // Check transaction status with retry logic
      let txStatus: TxStatus | null = null;
      if (txHash && txHash !== "TXID_BUY_STUB") {
        txStatus = await this.checkTxStatus(txHash);

        let retry: number = 1;
        while (!txStatus.confirmed && retry <= 3) {
          console.log(`😴 Transaction not confirmed yet. Retry ${retry}/3...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          txStatus = await this.checkTxStatus(txHash);
          retry++;
        }

        if (txStatus.confirmed) {
          console.log(`✅ Transaction confirmed after ${retry - 1} retries`);
        } else {
          console.log(`⚠️ Transaction not confirmed after 3 retries`);
        }
      } else {
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

      // 💾 Save to database ONLY if transaction is confirmed
      if (txStatus?.confirmed && txHash && txHash !== "TXID_BUY_STUB") {
        try {
          console.log(`💾 Saving successful buy transaction to database...`);

          await transactionRepo.createSuccessful(
            txHash,
            walletPublicKey,
            mint,
            "BUY",
            {
              sol_amount: finalAmount,
              token_amount: "0", // Will be updated when we get actual tokens received
              price_per_token: onChain?.currentPriceUSD || result.price,
              slippage_percent: finalSlippage,
              priority_fee: finalPriorityFee,
              priority_type: priority || "normal",
              stop_loss_percent: finalStopLoss,
              take_profit_percent: finalTakeProfit,
              price_impact_percent: calculatedPriceImpact,
              total_cost: finalAmount + finalPriorityFee,
              on_chain_data: onChain, // Save the complete on-chain data object
            }
          );
        } catch (dbError) {
          console.error(
            "❌ Failed to save successful transaction:",
            dbError.message
          );
          this.logger.logError("DB_SAVE_SUCCESS", dbError.message);
          // Continue anyway - don't fail the trade because of DB issues
        }
      }

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
          onChainData: onChain,
          walletBalance: walletBalance,
          priceImpact: calculatedPriceImpact,
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
    percentage?: number,
    onChain?: OnChainData
  ): Promise<ApiResponse> {
    let txHash: string | undefined;
    let walletPublicKey: string | undefined;
    let calculatedPriceImpact = 0;

    try {
      const sellPercent = percentage || 100;
      console.log(`💰 SELL REQUEST: ${sellPercent}% of ${mint} holdings`);

      // Log received on-chain data
      if (onChain) {
        console.log(`📊 On-chain data for SELL:`);
        console.log(`   Price: $${onChain.currentPriceUSD}`);
        console.log(`   Liquidity: $${onChain.liquidityUSD}`);
        console.log(`   Volume 24h: $${onChain.volume24h}`);
        console.log(`   Pool exists: ${onChain.poolExists}`);
        console.log(`   DEX: ${onChain.dexType}`);
        console.log(
          `   Token: ${onChain.symbol || "Unknown"} (${
            onChain.name || "Unknown"
          })`
        );

        if (onChain.whales1h) {
          console.log(
            `   Whales 1h: ${onChain.whales1h.whaleCount} whales, risk: ${onChain.whales1h.whaleRisk}`
          );
        }

        if (onChain.tokenTax > 0) {
          console.log(`   Token tax: ${onChain.tokenTax}%`);
        }

        if (onChain.topHolderPercent > 0) {
          console.log(`   Top holder: ${onChain.topHolderPercent}%`);
        }
      }

      // Validate wallet
      if (!this.currentWallet) {
        const error = "No wallet configured. Set wallet first.";
        this.logger.logTrade("SELL", mint, 0, undefined, false, error);
        return { success: false, error };
      }

      // Get wallet public key
      const keypair = Keypair.fromSecretKey(bs58.decode(this.currentWallet));
      walletPublicKey = keypair.publicKey.toString();

      // Validate mint
      if (!mint || mint.length < 32) {
        const error = "Invalid mint address";
        this.logger.logTrade("SELL", mint, 0, undefined, false, error);
        return { success: false, error };
      }

      // Validate percentage
      if (sellPercent <= 0 || sellPercent > 100) {
        const error = "Percentage must be between 1 and 100";
        this.logger.logTrade("SELL", mint, 0, undefined, false, error);
        return { success: false, error };
      }

      // Use on-chain data for safety checks
      if (onChain) {
        // Check if pool exists
        if (!onChain.poolExists) {
          const error = "No tradeable pool exists for this token";
          this.logger.logTrade("SELL", mint, 0, undefined, false, error);
          return { success: false, error };
        }

        // Check token tax
        if (onChain.tokenTax && onChain.tokenTax > 10) {
          const error = `Token tax too high: ${onChain.tokenTax}% (max 10%)`;
          this.logger.logTrade("SELL", mint, 0, undefined, false, error);
          return { success: false, error };
        }

        // Check whale risk
        if (onChain.whales1h && onChain.whales1h.whaleRisk === "high") {
          console.log(`⚠️ Warning: High whale risk detected for ${mint}`);
        }

        // Check holder concentration
        if (onChain.topHolderPercent > 50) {
          console.log(
            `⚠️ Warning: Top holder owns ${onChain.topHolderPercent}% of supply`
          );
        }
      }

      // Get actual wallet token balance
      console.log(`💰 Checking wallet token balance for ${mint}...`);
      const walletTokenBalance = await this.getWalletTokenBalance(mint);
      console.log(`   Available tokens: ${walletTokenBalance}`);

      if (walletTokenBalance === 0) {
        const error = `No tokens found for ${mint} in wallet`;
        this.logger.logTrade("SELL", mint, 0, undefined, false, error);
        return { success: false, error };
      }

      // Calculate actual amount to sell based on percentage
      const actualSellAmount = Math.floor(
        (walletTokenBalance * sellPercent) / 100
      );
      console.log(
        `📊 Selling ${sellPercent}% of ${walletTokenBalance} tokens = ${actualSellAmount} tokens`
      );

      if (actualSellAmount <= 0) {
        const error = `Calculated sell amount is 0 (${sellPercent}% of ${walletTokenBalance})`;
        this.logger.logTrade("SELL", mint, 0, undefined, false, error);
        return { success: false, error };
      }

      // Calculate price impact if we have reserve data
      if (
        onChain &&
        onChain.solReserve &&
        onChain.tokenReserve &&
        onChain.solReserve > 0 &&
        onChain.tokenReserve > 0
      ) {
        // For sells, convert token amount to SOL equivalent for impact calculation
        const tokenToSolRatio = onChain.solReserve / onChain.tokenReserve;
        const solEquivalent = actualSellAmount * tokenToSolRatio;

        // Calculate impact (negative SOL amount for selling)
        calculatedPriceImpact = this.calculatePriceImpact(
          onChain.solReserve,
          onChain.tokenReserve,
          -solEquivalent
        );

        console.log(
          `   Price Impact: ${calculatedPriceImpact.toFixed(
            2
          )}% (calculated for SELL)`
        );

        // Safety check
        if (calculatedPriceImpact > 15) {
          // Higher threshold for sells
          const error = `Price impact too high: ${calculatedPriceImpact.toFixed(
            2
          )}% (max 15% for sells)`;
          this.logger.logTrade(
            "SELL",
            mint,
            actualSellAmount,
            undefined,
            false,
            error
          );
          return { success: false, error };
        }
      } else {
        console.log(`   Price Impact: Cannot calculate (missing reserve data)`);
      }

      // Execute sell
      const result = await jupiter_sell(mint, actualSellAmount);
      txHash = result.txid;

      // Check transaction status with retry logic
      let txStatus: TxStatus | null = null;
      if (txHash && txHash !== "TXID_SELL_STUB") {
        txStatus = await this.checkTxStatus(txHash);

        let retry: number = 1;
        while (!txStatus.confirmed && retry <= 3) {
          console.log(
            `😴 Sell transaction not confirmed yet. Retry ${retry}/3...`
          );
          await new Promise((resolve) => setTimeout(resolve, 2000));
          txStatus = await this.checkTxStatus(txHash);
          retry++;
        }

        if (txStatus.confirmed) {
          console.log(
            `✅ Sell transaction confirmed after ${retry - 1} retries`
          );
        } else {
          console.log(`⚠️ Sell transaction not confirmed after 3 retries`);
        }
      } else {
        txStatus = { tx_hash: txHash || "STUB", confirmed: true };
      }

      // Log successful trade
      this.logger.logTrade(
        "SELL",
        mint,
        actualSellAmount,
        txHash,
        txStatus?.confirmed
      );

      Notifications.emit({
        type: "sell",
        level: "success",
        title: `SELL ${mint}`,
        body: `${actualSellAmount} tokens (${sellPercent}%)`,
        link: result.txid,
      });

      // 💾 Save to database ONLY if transaction is confirmed
      if (txStatus?.confirmed && txHash && txHash !== "TXID_SELL_STUB") {
        try {
          console.log(`💾 Saving successful sell transaction to database...`);

          await transactionRepo.createSuccessful(
            txHash,
            walletPublicKey,
            mint,
            "SELL",
            {
              sol_amount: result.solReceived || 0,
              token_amount: actualSellAmount.toString(),
              price_per_token: result.solReceived
                ? result.solReceived / actualSellAmount
                : onChain?.currentPriceUSD || 0,
              slippage_percent: 3.0,
              priority_fee: 0.0001,
              priority_type: "normal",
              price_impact_percent: calculatedPriceImpact,
              total_cost: result.solReceived || 0,
              on_chain_data: onChain,
            }
          );
        } catch (dbError) {
          console.error(
            "❌ Failed to save successful sell transaction:",
            dbError.message
          );
          this.logger.logError("DB_SAVE_SUCCESS", dbError.message);
          // Continue anyway - don't fail the trade because of DB issues
        }
      }

      return {
        success: true,
        data: {
          txid: result.txid,
          mint,
          tokensInWallet: walletTokenBalance,
          tokensSold: actualSellAmount,
          percentage: sellPercent,
          solReceived: result.solReceived || 0,
          timestamp: new Date().toISOString(),
          tx_status: txStatus,
          onChainData: onChain,
          priceImpact: calculatedPriceImpact,
        },
        message: `Successfully sold ${actualSellAmount} tokens (${sellPercent}%) of ${mint}`,
      };
    } catch (error) {
      this.logger.logTrade("SELL", mint, 0, txHash, false, error.message);
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

      const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
      const publicKey = keypair.publicKey.toString();

      this.logger.logWalletAction("SET_SUCCESS", publicKey);

      return {
        success: true,
        message: "Wallet updated successfully",
        data: {
          hasPrivateKey: true,
          address: publicKey,
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

  private async getWalletTokenBalance(tokenMint: string): Promise<number> {
    try {
      if (!this.currentWallet) {
        throw new Error("No wallet configured");
      }

      // Validate mint address format
      let mintPublicKey: PublicKey;
      try {
        mintPublicKey = new PublicKey(tokenMint);
        // Additional validation - check if it's a valid base58 string
        if (mintPublicKey.toString() !== tokenMint) {
          throw new Error("Invalid mint address format");
        }
      } catch (error) {
        throw new Error(`Invalid mint address: ${tokenMint}`);
      }

      // Get public key from private key
      const keypair = Keypair.fromSecretKey(bs58.decode(this.currentWallet));
      const publicKey = keypair.publicKey;

      console.log(`🔍 Checking token balance for: ${tokenMint}`);
      console.log(`🔍 Wallet address: ${publicKey.toString()}`);

      // Get token accounts for this mint (use the PublicKey object)
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        publicKey,
        {
          mint: mintPublicKey, // ← Use PublicKey object, not string
        }
      );

      if (tokenAccounts.value.length === 0) {
        console.log(`❌ No token accounts found for ${tokenMint}`);
        return 0;
      }

      // Get the token account with the highest balance
      let totalBalance = 0;

      for (const tokenAccount of tokenAccounts.value) {
        const accountInfo = await this.connection.getTokenAccountBalance(
          tokenAccount.pubkey
        );
        const balance = parseFloat(accountInfo.value.amount);
        totalBalance += balance;
        console.log(
          `💰 Account ${tokenAccount.pubkey.toString()}: ${balance} tokens`
        );
      }

      console.log(`🪙 Total token balance: ${totalBalance}`);
      return totalBalance;
    } catch (error) {
      console.error(`❌ Failed to get token balance:`, error.message);
      this.logger.logError("GET_TOKEN_BALANCE", error.message);
      return 0;
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
        body.priority_fee,
        body.priority,
        body.onChain
      );
      statusCode = result.success ? 200 : 400;
    }

    // Sell endpoint
    else if (method === "POST" && url === "/api/sell") {
      const body: { mint: string; percentage?: number; onChain?: OnChainData } =
        await parseBody(req);
      result = await api.executeSell(body.mint, body.percentage, body.onChain);
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
