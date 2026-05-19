import { NextFunction, Request, Response } from 'express';

import AppError from '../../../../exception/AppError';
import { HTTPError } from '../../../../types/HTTPError';
import LockingHelper from '../../../../locking/LockingHelper';
import LockingManager from '../../../../locking/LockingManager';
import Logging from '../../../../utils/Logging';
import LoggingHelper from '../../../../utils/LoggingHelper';
import { ServerAction } from '../../../../types/Server';
import { StatusCodes } from 'http-status-codes';
import Tenant from '../../../../types/Tenant';
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

  // ---------------------------------------------------------------------------
  // Helpers privés
  // ---------------------------------------------------------------------------

  private static isAdmin(req: Request): boolean {
    // Les rôles admin dans ev-server : 'A' (Admin) ou 'S' (Super Admin)
    return req.user?.role === 'A' || req.user?.role === 'S';
  }
}
