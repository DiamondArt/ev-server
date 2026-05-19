import { RESTServerRoute, ServerAction } from '../../../../../types/Server';
import express, { NextFunction, Request, Response } from 'express';

import RouterUtils from '../../../../../utils/RouterUtils';
import WalletService from '../../service/WalletService';

export default class WalletRouter {
  private router: express.Router;

  public constructor() {
    this.router = express.Router();
  }

  public buildRoutes(): express.Router {
    this.buildRouteWalletBalance();
    this.buildRouteWalletTopUp();
    return this.router;
  }

  /**
   * GET /v1/api/wallet/users/:userID/balance
   * Consulter le solde wallet d'un utilisateur
   */
  protected buildRouteWalletBalance(): void {
    this.router.get(`/${RESTServerRoute.REST_WALLET_BALANCE}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(WalletService.handleGetWalletBalance.bind(this), ServerAction.WALLET_GET_BALANCE, req, res, next);
    });
  }

  /**
   * POST /v1/api/wallet/users/:userID/top-up
   * Recharger le wallet d'un utilisateur (admin uniquement)
   */
  protected buildRouteWalletTopUp(): void {
    this.router.post(`/${RESTServerRoute.REST_WALLET_TOP_UP}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(WalletService.handleWalletTopUp.bind(this), ServerAction.WALLET_TOP_UP, req, res, next);
    });
  }
}
