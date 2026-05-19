import { NextFunction, Request, Response } from 'express';

import AppError from '../../../../exception/AppError';
import { HTTPError } from '../../../../types/HTTPError';
import { WalletTransactionType } from '../../../../types/Billing';
import LockingHelper from '../../../../locking/LockingHelper';
import LockingManager from '../../../../locking/LockingManager';
import Logging from '../../../../utils/Logging';
import LoggingHelper from '../../../../utils/LoggingHelper';
import { ServerAction } from '../../../../types/Server';
import { StatusCodes } from 'http-status-codes';
import Tenant from '../../../../types/Tenant';
import Utils from '../../../../utils/Utils';
import WalletStorage from '../../../../storage/mongodb/WalletStorage';

const MODULE_NAME = 'WalletService';

export default class WalletService {

  /**
   * GET /v1/api/wallet/users/:userID/balance
   * Retourne le solde wallet de l'utilisateur.
   * Accessible par l'admin ou par l'utilisateur lui-même.
   */
  public static async handleGetWalletBalance(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    const userID = req.params.userID;
    // Vérification basique : l'utilisateur ne peut consulter que son propre wallet (sauf admin)
    if (!req.user.role || (req.user.id !== userID && !WalletService.isAdmin(req))) {
      throw new AppError({
        errorCode: HTTPError.GENERAL_ERROR,
        message: `Accès refusé au wallet de l'utilisateur '${userID}'`,
        module: MODULE_NAME, method: 'handleGetWalletBalance',
        action,
        user: req.user,
      });
    }
    const wallet = await WalletStorage.getWalletByUserID(req.tenant as Tenant, userID);
    await Logging.logInfo({
      tenantID: req.user.tenantID,
      user: req.user,
      module: MODULE_NAME, method: 'handleGetWalletBalance',
      action,
      message: `Consultation solde wallet utilisateur '${userID}': ${wallet?.balance ?? 0} XOF`,
    });
    res.json({
      userID,
      balance: wallet?.balance ?? 0,
      currency: wallet?.currency ?? 'XOF',
      lastTopUp: wallet?.lastTopUp ?? null,
    });
    next();
  }

  /**
   * POST /v1/api/wallet/users/:userID/top-up
   * Recharge le wallet d'un utilisateur.
   * Réservé aux administrateurs.
   * Body: { amount: number (XOF, entier positif), reference?: string }
   */
  public static async handleWalletTopUp(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Admin uniquement
    if (!WalletService.isAdmin(req)) {
      throw new AppError({
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Seul un administrateur peut recharger un wallet',
        module: MODULE_NAME, method: 'handleWalletTopUp',
        action,
        user: req.user,
      });
    }
    const userID = req.params.userID;
    const { amount, reference } = req.body as { amount: number; reference?: string };
    // Validation du montant
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new AppError({
        errorCode: HTTPError.GENERAL_ERROR,
        message: `Le montant de recharge doit être un entier positif en XOF (reçu: ${amount})`,
        module: MODULE_NAME, method: 'handleWalletTopUp',
        action,
        user: req.user,
      });
    }
    // Verrou pour éviter les top-ups concurrents
    const lock = await LockingHelper.acquireWalletTopUpLock(req.user.tenantID, userID);
    if (!lock) {
      throw new AppError({
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Une opération de recharge est déjà en cours pour cet utilisateur',
        module: MODULE_NAME, method: 'handleWalletTopUp',
        action,
        user: req.user,
      });
    }
    try {
      const newBalance = await WalletStorage.adjustBalance(req.tenant as Tenant, userID, amount);
      await Logging.logInfo({
        tenantID: req.user.tenantID,
        user: req.user,
        module: MODULE_NAME, method: 'handleWalletTopUp',
        action,
        message: `Recharge wallet: +${amount} XOF pour utilisateur '${userID}'${reference ? ` (réf: ${reference})` : ''} — Nouveau solde: ${newBalance} XOF`,
      });
      res.json({
        userID,
        balance: newBalance,
        currency: 'XOF',
        topUpAmount: amount,
        reference: reference ?? null,
      });
    } finally {
      await LockingManager.release(lock);
    }
    next();
  }

  /**
   * GET /v1/api/wallet/transactions
   * Historique des transactions wallet avec filtres.
   * Paramètres supportés :
   *   - UserID         : filtrer par utilisateur
   *   - DateFrom       : date de début (ISO 8601)
   *   - DateTo         : date de fin   (ISO 8601)
   *   - Type           : 'top-up' ou 'deduction'
   *   - Limit          : nb résultats (défaut 50)
   *   - Skip           : pagination offset
   *   - SortFields     : ex. 'createdOn'
   *   - SortDirs       : '1' ou '-1'
   */
  public static async handleGetWalletTransactions(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Admin ou l'utilisateur lui-même (si UserID fourni correspond à son propre ID)
    const { UserID, DateFrom, DateTo, Type, Limit, Skip, SortFields, SortDirs } = req.query as Record<string, string>;
    const isAdmin = WalletService.isAdmin(req);
    if (!isAdmin) {
      // Un utilisateur standard ne peut voir que ses propres transactions
      if (UserID && UserID !== req.user.id) {
        throw new AppError({
          errorCode: HTTPError.GENERAL_ERROR,
          message: 'Accès refusé : vous ne pouvez consulter que vos propres transactions wallet',
          module: MODULE_NAME, method: 'handleGetWalletTransactions',
          action,
          user: req.user,
        });
      }
    }
    // Filtres
    const userIDs: string[] = [];
    if (UserID) {
      userIDs.push(UserID);
    } else if (!isAdmin) {
      // non-admin sans UserID → force filtre sur lui-même
      userIDs.push(req.user.id);
    }
    const dateFrom = DateFrom ? new Date(DateFrom) : undefined;
    const dateTo   = DateTo   ? new Date(DateTo)   : undefined;
    const types: WalletTransactionType[] = [];
    if (Type) {
      if (Object.values(WalletTransactionType).includes(Type as WalletTransactionType)) {
        types.push(Type as WalletTransactionType);
      }
    }
    // Pagination & tri
    const limit = Math.min(parseInt(Limit ?? '50', 10) || 50, 500);
    const skip  = parseInt(Skip ?? '0', 10) || 0;
    const sortField = SortFields ?? 'createdOn';
    const sortDir   = parseInt(SortDirs ?? '-1', 10) as 1 | -1;
    const sort: Record<string, 1 | -1> = { [sortField]: sortDir };
    const { count, result } = await WalletStorage.getWalletTransactions(
      req.tenant as Tenant,
      { userIDs, dateFrom, dateTo, types },
      { limit, skip, sort }
    );
    await Logging.logInfo({
      tenantID: req.user.tenantID,
      user: req.user,
      module: MODULE_NAME, method: 'handleGetWalletTransactions',
      action,
      message: `Historique transactions wallet: ${count} résultat(s)`,
    });
    res.json({
      count,
      result,
    });
    next();
  }

  // ---------------------------------------------------------------------------
  // Helpers privés
  // ---------------------------------------------------------------------------

  private static isAdmin(req: Request): boolean {
    // Les rôles admin dans ev-server : 'A' (Admin) ou 'S' (Super Admin)
    return req.user?.role === 'A' || req.user?.role === 'S';
  }
}
