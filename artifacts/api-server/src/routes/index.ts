import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import quotationsRouter from "./quotations";
import comparisonRouter from "./comparison";

const router: IRouter = Router();

router.use(healthRouter);
router.use(projectsRouter);
router.use(quotationsRouter);
router.use(comparisonRouter);

export default router;
