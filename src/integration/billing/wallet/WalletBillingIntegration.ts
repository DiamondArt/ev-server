/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  BillingAccount,
  BillingDataTransactionStart,
  BillingDataTransactionStop,
  BillingDataTransactionUpdate,
  BillingInvoice,
  BillingInvoiceItem,
  BillingInvoiceStatus,
  BillingOperationResult,
  BillingPaymentMethod,
  BillingPlatformInvoice,
  BillingStatus,
  BillingTax,
  BillingTransfer,
  BillingUser,
} from '../../../types/Billing';
import { BillingPeriodicOperationTaskConfig, DispatchFundsTaskConfig } from '../../../types/TaskConfig';
import Transaction, { StartTransactionErrorCode } from '../../../types/Transaction';
import User, { UserStatus } from '../../../types/User';

import BackendError from '../../../exception/BackendError';
import { BillingSettings } from '../../../types/Setting';
import BillingIntegration from '../BillingIntegration';
import ChargingStation from '../../../types/ChargingStation';
import LockingHelper from '../../../locking/LockingHelper';
import LockingManager from '../../../locking/LockingManager';
import Logging from '../../../utils/Logging';
import { Request } from 'express';
import { ServerAction } from '../../../types/Server';
import SiteArea from '../../../types/SiteArea';
import Tenant from '../../../types/Tenant';
import WalletStorage from '../../../storage/mongodb/WalletStorage';
import Utils from '../../../utils/Utils';

const MODULE_NAME = 'WalletBillingIntegration';

export default class WalletBillingIntegration extends BillingIntegration {

  public constructor(tenant: Tenant, settings: BillingSettings) {
    super(tenant, settings);
  }

  public static getInstance(tenant: Tenant, settings: BillingSettings): WalletBillingIntegration | null {
    if (settings?.wallet?.currency && settings?.wallet?.minimumBalance !== undefined) {
      return new WalletBillingIntegration(tenant, settings);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Connection & Prerequisites
  // ---------------------------------------------------------------------------

  public async checkConnection(): Promise<void> {
    // Aucune connexion externe — le wallet est 100% local MongoDB
  }

  public async checkActivationPrerequisites(): Promise<void> {
    if (!this.settings.wallet?.currency) {
      throw new BackendError({
        message: 'Wallet Billing: currency is not configured',
        module: MODULE_NAME, method: 'checkActivationPrerequisites',
        action: ServerAction.BILLING,
      });
    }
    if (this.settings.wallet?.minimumBalance < 0) {
      throw new BackendError({
        message: 'Wallet Billing: minimumBalance must be >= 0',
        module: MODULE_NAME, method: 'checkActivationPrerequisites',
        action: ServerAction.BILLING,
      });
    }
  }

  public async checkTestDataCleanupPrerequisites(): Promise<void> {
    // Pas de données de test à nettoyer
  }

  public async resetConnectionSettings(): Promise<BillingSettings> {
    return this.settings;
  }

  // ---------------------------------------------------------------------------
  // Gestion utilisateurs (wallet ne nécessite pas de synchronisation externe)
  // ---------------------------------------------------------------------------

  public async isUserSynchronized(user: User): Promise<boolean> {
    // Un utilisateur wallet est toujours considéré comme synchronisé
    return true;
  }

  public async checkIfUserCanBeCreated(user: User): Promise<boolean> {
    return true;
  }

  public async checkIfUserCanBeUpdated(user: User): Promise<boolean> {
    return true;
  }

  public async checkIfUserCanBeDeleted(user: User): Promise<boolean> {
    return true;
  }

  public async getUser(user: User): Promise<BillingUser> {
    return { billingData: {} };
  }

  public async createUser(user: User): Promise<BillingUser> {
    // Initialiser le wallet à 0 pour le nouvel utilisateur
    await WalletStorage.initWallet(this.tenant, user.id);
    return { billingData: {} };
  }

  public async updateUser(user: User): Promise<BillingUser> {
    return { billingData: {} };
  }

  public async repairUser(user: User): Promise<BillingUser> {
    return { billingData: {} };
  }

  public async deleteUser(user: User): Promise<void> {
    await WalletStorage.deleteWalletByUserID(this.tenant, user.id);
  }

  // ---------------------------------------------------------------------------
  // Overrides des checks de transaction (pas de customerID pour wallet)
  // ---------------------------------------------------------------------------

  public checkBillTransaction(transaction: Transaction): void {
    if (!transaction.userID || !transaction.user) {
      throw new BackendError({
        message: 'User is not provided',
        module: MODULE_NAME, method: 'checkBillTransaction',
        action: ServerAction.BILLING_TRANSACTION,
      });
    }
    if (!transaction.chargeBox) {
      throw new BackendError({
        message: 'Charging Station is not provided',
        module: MODULE_NAME, method: 'checkBillTransaction',
        action: ServerAction.BILLING_TRANSACTION,
      });
    }
    // Pas de vérification customerID — wallet ne s'appuie pas sur Stripe
  }

  public checkStartTransaction(transaction: Transaction, chargingStation: ChargingStation, siteArea: SiteArea): boolean {
    if (!this.settings.billing.isTransactionBillingActivated) {
      return false;
    }
    if (!transaction.userID || !transaction.user) {
      throw new BackendError({
        message: 'User ID is not provided',
        module: MODULE_NAME, method: 'checkStartTransaction',
        action: ServerAction.BILLING_TRANSACTION,
      });
    }
    if (transaction.user.freeAccess) {
      return false;
    }
    // Pas de vérification customerID — wallet ne s'appuie pas sur Stripe
    return true;
  }

  // ---------------------------------------------------------------------------
  // Cycle de vie de la transaction OCPP
  // ---------------------------------------------------------------------------

  /**
   * Vérifie le solde avant d'autoriser le démarrage d'une session.
   * Appelé lors du pré-check (avant RemoteStartTransaction).
   */
  public async precheckStartTransactionPrerequisites(user: User): Promise<StartTransactionErrorCode[]> {
    const errors: StartTransactionErrorCode[] = [];
    if (!this.settings.billing.isTransactionBillingActivated) {
      return errors;
    }
    if (user?.freeAccess) {
      return errors;
    }
    const wallet = await WalletStorage.getWalletByUserID(this.tenant, user.id);
    const balance = wallet?.balance ?? 0;
    const minimum = this.settings.wallet?.minimumBalance ?? 0;
    if (balance < minimum) {
      await Logging.logWarning({
        tenantID: this.tenant.id,
        user: user.id,
        module: MODULE_NAME, method: 'precheckStartTransactionPrerequisites',
        action: ServerAction.BILLING_TRANSACTION,
        message: `Solde wallet insuffisant: ${balance} XOF < ${minimum} XOF minimum`,
      });
      errors.push(StartTransactionErrorCode.BILLING_INSUFFICIENT_WALLET_FUNDS);
    }
    return errors;
  }

  /**
   * Vérifie à nouveau le solde au démarrage réel de la session.
   */
  public async startTransaction(transaction: Transaction): Promise<BillingDataTransactionStart> {
    if (!this.settings.billing.isTransactionBillingActivated) {
      return { withBillingActive: false };
    }
    if (transaction.user?.freeAccess) {
      return { withBillingActive: false };
    }
    const wallet = await WalletStorage.getWalletByUserID(this.tenant, transaction.userID);
    const balance = wallet?.balance ?? 0;
    const minimum = this.settings.wallet?.minimumBalance ?? 0;
    if (balance < minimum) {
      throw new BackendError({
        message: `Solde wallet (${balance} XOF) insuffisant — minimum requis: ${minimum} XOF`,
        module: MODULE_NAME, method: 'startTransaction',
        action: ServerAction.BILLING_TRANSACTION,
        user: transaction.userID,
      });
    }
    await Logging.logInfo({
      tenantID: this.tenant.id,
      user: transaction.userID,
      module: MODULE_NAME, method: 'startTransaction',
      action: ServerAction.BILLING_TRANSACTION,
      message: `Session démarrée — Solde wallet: ${balance} XOF`,
    });
    return { withBillingActive: true };
  }

  /**
   * Pas d'opération mid-session.
   */
  public async updateTransaction(transaction: Transaction): Promise<BillingDataTransactionUpdate> {
    return { withBillingActive: transaction.billingData?.withBillingActive ?? false };
  }

  /**
   * Marque la session comme PENDING — le débit réel se fait dans endTransaction.
   */
  public async stopTransaction(transaction: Transaction): Promise<BillingDataTransactionStop> {
    if (!transaction.billingData?.withBillingActive) {
      return { status: BillingStatus.UNBILLED };
    }
    return { status: BillingStatus.PENDING };
  }

  /**
   * Débit atomique du wallet à la fin de la session.
   * Utilise un verrou distribué pour éviter les doubles débits.
   */
  public async endTransaction(transaction: Transaction): Promise<BillingDataTransactionStop> {
    if (!transaction.billingData?.withBillingActive) {
      return { status: BillingStatus.UNBILLED };
    }
    // Déjà facturé ?
    if (transaction.billingData?.stop?.status === BillingStatus.BILLED) {
      return transaction.billingData.stop;
    }
    const amountToBill = this.computeTransactionAmount(transaction);
    if (amountToBill <= 0) {
      return { status: BillingStatus.UNBILLED };
    }
    // Verrou distribué pour éviter les doubles débits
    const lock = await LockingHelper.acquireWalletDeductionLock(this.tenant.id, transaction.userID);
    if (!lock) {
      await Logging.logWarning({
        tenantID: this.tenant.id,
        user: transaction.userID,
        module: MODULE_NAME, method: 'endTransaction',
        action: ServerAction.BILLING_TRANSACTION,
        message: `Impossible d'acquérir le verrou wallet — débit reporté (transaction ${transaction.id})`,
      });
      return { status: BillingStatus.PENDING };
    }
    try {
      const newBalance = await WalletStorage.adjustBalance(this.tenant, transaction.userID, -amountToBill);
      await Logging.logInfo({
        tenantID: this.tenant.id,
        user: transaction.userID,
        module: MODULE_NAME, method: 'endTransaction',
        action: ServerAction.BILLING_TRANSACTION,
        message: `Débit wallet: -${amountToBill} XOF (transaction ${transaction.id}) — Nouveau solde: ${newBalance} XOF`,
      });
      return {
        status: BillingStatus.BILLED,
        invoiceID: null,
        invoiceStatus: BillingInvoiceStatus.PAID,
        invoiceNumber: `WALLET-${transaction.id}`,
      };
    } finally {
      await LockingManager.release(lock);
    }
  }

  public async billTransaction(transaction: Transaction): Promise<BillingDataTransactionStop> {
    return this.endTransaction(transaction);
  }

  // ---------------------------------------------------------------------------
  // Méthodes Stripe non supportées — stubs requis par la classe abstraite
  // ---------------------------------------------------------------------------

  public async getTaxes(): Promise<BillingTax[]> {
    return [];
  }

  public async billInvoiceItem(user: User, billingInvoiceItems: BillingInvoiceItem): Promise<BillingInvoice> {
    throw new BackendError({ message: 'Non supporté par WalletBillingIntegration', module: MODULE_NAME, method: 'billInvoiceItem', action: ServerAction.BILLING });
  }

  public async downloadInvoiceDocument(invoice: BillingInvoice): Promise<Buffer> {
    throw new BackendError({ message: 'Non supporté par WalletBillingIntegration', module: MODULE_NAME, method: 'downloadInvoiceDocument', action: ServerAction.BILLING });
  }

  public async downloadTransferInvoiceDocument(transfer: BillingTransfer): Promise<Buffer> {
    throw new BackendError({ message: 'Non supporté par WalletBillingIntegration', module: MODULE_NAME, method: 'downloadTransferInvoiceDocument', action: ServerAction.BILLING });
  }

  public async chargeInvoice(invoice: BillingInvoice): Promise<BillingInvoice> {
    throw new BackendError({ message: 'Non supporté par WalletBillingIntegration', module: MODULE_NAME, method: 'chargeInvoice', action: ServerAction.BILLING });
  }

  public async consumeBillingEvent(req: Request): Promise<boolean> {
    return false;
  }

  public async setupPaymentMethod(user: User, paymentMethodId: string): Promise<BillingOperationResult> {
    throw new BackendError({ message: 'Non supporté par WalletBillingIntegration', module: MODULE_NAME, method: 'setupPaymentMethod', action: ServerAction.BILLING });
  }

  public async getPaymentMethods(user: User): Promise<BillingPaymentMethod[]> {
    return [];
  }

  public async deletePaymentMethod(user: User, paymentMethodId: string): Promise<BillingOperationResult> {
    throw new BackendError({ message: 'Non supporté par WalletBillingIntegration', module: MODULE_NAME, method: 'deletePaymentMethod', action: ServerAction.BILLING });
  }

  public async createConnectedAccount(): Promise<Partial<BillingAccount>> {
    throw new BackendError({ message: 'Non supporté par WalletBillingIntegration', module: MODULE_NAME, method: 'createConnectedAccount', action: ServerAction.BILLING });
  }

  public async refreshConnectedAccount(billingAccount: BillingAccount, url: string): Promise<Partial<BillingAccount>> {
    throw new BackendError({ message: 'Non supporté par WalletBillingIntegration', module: MODULE_NAME, method: 'refreshConnectedAccount', action: ServerAction.BILLING });
  }

  public async billPlatformFee(transfer: BillingTransfer, user: User, billingAccount: BillingAccount): Promise<BillingPlatformInvoice> {
    throw new BackendError({ message: 'Non supporté par WalletBillingIntegration', module: MODULE_NAME, method: 'billPlatformFee', action: ServerAction.BILLING });
  }

  public async sendTransfer(transfer: BillingTransfer, user: User): Promise<string> {
    throw new BackendError({ message: 'Non supporté par WalletBillingIntegration', module: MODULE_NAME, method: 'sendTransfer', action: ServerAction.BILLING });
  }

  // ---------------------------------------------------------------------------
  // Helpers privés
  // ---------------------------------------------------------------------------

  /**
   * Calcule le montant à débiter en XOF depuis les données de pricing de la transaction.
   * Utilise le prix arrondi calculé par BuiltInPricingIntegration.
   */
  private computeTransactionAmount(transaction: Transaction): number {
    const roundedPrice = transaction.stop?.roundedPrice ?? 0;
    // On arrondit au supérieur pour s'assurer que le montant entier est couvert
    return Math.ceil(roundedPrice);
  }
}
