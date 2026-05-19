import { WalletEntry, WalletTransaction, WalletTransactionType } from '../../types/Billing';
import global from '../../types/GlobalType';
import DatabaseUtils from './DatabaseUtils';
import Logging from '../../utils/Logging';
import { ObjectId } from 'mongodb';
import { ServerAction } from '../../types/Server';
import Tenant from '../../types/Tenant';
import Utils from '../../utils/Utils';

const MODULE_NAME = 'WalletStorage';

export default class WalletStorage {

  /**
   * Récupère le wallet d'un utilisateur.
   * Retourne null si aucun wallet n'existe encore.
   */
  public static async getWalletByUserID(tenant: Tenant, userID: string): Promise<WalletEntry | null> {
    const startTime = Logging.traceDatabaseRequestStart();
    DatabaseUtils.checkTenantObject(tenant);
    const walletMDB = await global.database.getCollection<any>(tenant.id, 'wallets').findOne(
      { userID: DatabaseUtils.convertToObjectID(userID) }
    );
    await Logging.traceDatabaseRequestEnd(tenant, MODULE_NAME, 'getWalletByUserID', startTime, { userID });
    if (!walletMDB) {
      return null;
    }
    return WalletStorage.convertWalletFromDB(walletMDB);
  }

  /**
   * Sauvegarde (upsert) le wallet d'un utilisateur.
   * Crée le wallet s'il n'existe pas encore.
   */
  public static async saveWallet(tenant: Tenant, wallet: WalletEntry): Promise<string> {
    const startTime = Logging.traceDatabaseRequestStart();
    DatabaseUtils.checkTenantObject(tenant);
    const walletMDB: any = {
      userID: DatabaseUtils.convertToObjectID(wallet.userID),
      tenantID: tenant.id,
      balance: Utils.convertToFloat(wallet.balance),
      currency: wallet.currency,
      lastChangedOn: Utils.convertToDate(wallet.lastChangedOn ?? new Date()),
    };
    if (wallet.lastTopUp) {
      walletMDB.lastTopUp = Utils.convertToDate(wallet.lastTopUp);
    }
    if (wallet.id) {
      walletMDB._id = DatabaseUtils.convertToObjectID(wallet.id);
    } else {
      walletMDB._id = new ObjectId();
    }
    // Upsert
    await global.database.getCollection<any>(tenant.id, 'wallets').findOneAndUpdate(
      { userID: DatabaseUtils.convertToObjectID(wallet.userID) },
      { $set: walletMDB, $setOnInsert: { createdOn: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );
    await Logging.traceDatabaseRequestEnd(tenant, MODULE_NAME, 'saveWallet', startTime, walletMDB);
    return walletMDB._id.toString();
  }

  /**
   * Ajuste atomiquement le solde du wallet (delta positif = recharge, négatif = débit).
   * Crée le wallet si inexistant (solde de départ = 0 + delta).
   * Enregistre une WalletTransaction dans wallettransactions.
   * Retourne le nouveau solde après ajustement.
   */
  public static async adjustBalance(
    tenant: Tenant, userID: string, delta: number,
    options: { reference?: string; ocppTransactionID?: number; createdBy?: string } = {}
  ): Promise<number> {
    const startTime = Logging.traceDatabaseRequestStart();
    DatabaseUtils.checkTenantObject(tenant);
    const now = new Date();
    // Read balance before update
    const walletBefore = await global.database.getCollection<any>(tenant.id, 'wallets').findOne(
      { userID: DatabaseUtils.convertToObjectID(userID) }
    );
    const balanceBefore: number = walletBefore?.balance ?? 0;
    const updateFields: any = {
      $inc: { balance: delta },
      $set: {
        tenantID: tenant.id,
        currency: 'XOF',
        lastChangedOn: now,
      },
      $setOnInsert: {
        userID: DatabaseUtils.convertToObjectID(userID),
        createdOn: now,
      },
    };
    if (delta > 0) {
      updateFields.$set.lastTopUp = now;
    }
    const result = await global.database.getCollection<any>(tenant.id, 'wallets').findOneAndUpdate(
      { userID: DatabaseUtils.convertToObjectID(userID) },
      updateFields,
      { upsert: true, returnDocument: 'after' }
    );
    const balanceAfter: number = balanceBefore + delta;
    // Record the transaction
    await WalletStorage.saveWalletTransaction(tenant, {
      userID,
      tenantID: tenant.id,
      type: delta >= 0 ? WalletTransactionType.TOP_UP : WalletTransactionType.DEDUCTION,
      amount: Math.abs(delta),
      balanceBefore,
      balanceAfter,
      currency: 'XOF',
      reference: options.reference,
      ocppTransactionID: options.ocppTransactionID,
      createdBy: options.createdBy,
      createdOn: now,
    });
    await Logging.traceDatabaseRequestEnd(tenant, MODULE_NAME, 'adjustBalance', startTime, { userID, delta });
    return balanceAfter;
  }

  /**
   * Persiste une WalletTransaction dans la collection wallettransactions.
   */
  public static async saveWalletTransaction(tenant: Tenant, tx: WalletTransaction): Promise<string> {
    const startTime = Logging.traceDatabaseRequestStart();
    DatabaseUtils.checkTenantObject(tenant);
    const txMDB: any = {
      _id: new ObjectId(),
      userID: DatabaseUtils.convertToObjectID(tx.userID),
      tenantID: tenant.id,
      type: tx.type,
      amount: Utils.convertToFloat(tx.amount),
      balanceBefore: Utils.convertToFloat(tx.balanceBefore),
      balanceAfter: Utils.convertToFloat(tx.balanceAfter),
      currency: tx.currency ?? 'XOF',
      createdOn: tx.createdOn ?? new Date(),
    };
    if (tx.reference) { txMDB.reference = tx.reference; }
    if (tx.ocppTransactionID) { txMDB.ocppTransactionID = tx.ocppTransactionID; }
    if (tx.createdBy) { txMDB.createdBy = tx.createdBy; }
    await global.database.getCollection<any>(tenant.id, 'wallettransactions').insertOne(txMDB);
    await Logging.traceDatabaseRequestEnd(tenant, MODULE_NAME, 'saveWalletTransaction', startTime, txMDB);
    return txMDB._id.toString();
  }

  /**
   * Récupère l'historique des transactions wallet avec filtres et pagination.
   */
  public static async getWalletTransactions(
    tenant: Tenant,
    params: {
      userIDs?: string[];
      dateFrom?: Date;
      dateTo?: Date;
      types?: WalletTransactionType[];
    },
    dbParams: { limit: number; skip: number; sort?: Record<string, 1 | -1> }
  ): Promise<{ count: number; result: WalletTransaction[] }> {
    const startTime = Logging.traceDatabaseRequestStart();
    DatabaseUtils.checkTenantObject(tenant);
    const matchFilters: any = { tenantID: tenant.id };
    if (params.userIDs?.length) {
      matchFilters.userID = { $in: params.userIDs.map((id) => DatabaseUtils.convertToObjectID(id)) };
    }
    if (params.types?.length) {
      matchFilters.type = { $in: params.types };
    }
    if (params.dateFrom || params.dateTo) {
      matchFilters.createdOn = {};
      if (params.dateFrom) { matchFilters.createdOn.$gte = params.dateFrom; }
      if (params.dateTo)   { matchFilters.createdOn.$lte = params.dateTo; }
    }
    const collection = global.database.getCollection<any>(tenant.id, 'wallettransactions');
    const [count, rawDocs] = await Promise.all([
      collection.countDocuments(matchFilters),
      collection
        .find(matchFilters)
        .sort(dbParams.sort ?? { createdOn: -1 })
        .skip(dbParams.skip ?? 0)
        .limit(dbParams.limit ?? 100)
        .toArray(),
    ]);
    const result: WalletTransaction[] = rawDocs.map((doc: any) => ({
      id: doc._id?.toString(),
      userID: doc.userID?.toString(),
      tenantID: doc.tenantID,
      type: doc.type,
      amount: doc.amount,
      balanceBefore: doc.balanceBefore,
      balanceAfter: doc.balanceAfter,
      currency: doc.currency ?? 'XOF',
      reference: doc.reference,
      ocppTransactionID: doc.ocppTransactionID,
      createdBy: doc.createdBy,
      createdOn: doc.createdOn,
    }));
    await Logging.traceDatabaseRequestEnd(tenant, MODULE_NAME, 'getWalletTransactions', startTime, params);
    return { count, result };
  }

  /**
   * Initialise un wallet à 0 pour un nouvel utilisateur.
   * Ne fait rien si le wallet existe déjà.
   */
  public static async initWallet(tenant: Tenant, userID: string): Promise<void> {
    const startTime = Logging.traceDatabaseRequestStart();
    DatabaseUtils.checkTenantObject(tenant);
    const now = new Date();
    await global.database.getCollection<any>(tenant.id, 'wallets').updateOne(
      { userID: DatabaseUtils.convertToObjectID(userID) },
      {
        $setOnInsert: {
          userID: DatabaseUtils.convertToObjectID(userID),
          tenantID: tenant.id,
          balance: 0,
          currency: 'XOF',
          createdOn: now,
          lastChangedOn: now,
        }
      },
      { upsert: true }
    );
    await Logging.traceDatabaseRequestEnd(tenant, MODULE_NAME, 'initWallet', startTime, { userID });
  }

  /**
   * Supprime le wallet d'un utilisateur (utilisé lors de la suppression de compte).
   */
  public static async deleteWalletByUserID(tenant: Tenant, userID: string): Promise<void> {
    const startTime = Logging.traceDatabaseRequestStart();
    DatabaseUtils.checkTenantObject(tenant);
    await global.database.getCollection<any>(tenant.id, 'wallets').deleteOne(
      { userID: DatabaseUtils.convertToObjectID(userID) }
    );
    await Logging.traceDatabaseRequestEnd(tenant, MODULE_NAME, 'deleteWalletByUserID', startTime, { userID });
  }

  // ---------------------------------------------------------------------------
  // Conversion DB → TypeScript
  // ---------------------------------------------------------------------------
  private static convertWalletFromDB(walletMDB: any): WalletEntry {
    return {
      id: walletMDB._id?.toString(),
      userID: walletMDB.userID?.toString(),
      tenantID: walletMDB.tenantID,
      balance: walletMDB.balance ?? 0,
      currency: walletMDB.currency ?? 'XOF',
      lastTopUp: walletMDB.lastTopUp,
      createdOn: walletMDB.createdOn,
      lastChangedOn: walletMDB.lastChangedOn,
    };
  }
}
