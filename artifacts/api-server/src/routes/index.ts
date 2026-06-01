import { Router, type IRouter } from "express";
  import healthRouter from "./health";
  import tasksRouter from "./tasks";
  import authRouter from "./auth";
  import settingsRouter from "./settings";
  import recorderRouter from "./recorder";
  import savedCredentialsRouter from "./saved-credentials";
  import { requireAuth } from "../middlewares/requireAuth";

  const router: IRouter = Router();

  router.use(healthRouter);
  router.use(authRouter);
  router.use(requireAuth);
  router.use(tasksRouter);
  router.use(settingsRouter);
  router.use(recorderRouter);
  router.use(savedCredentialsRouter);

  export default router;
  