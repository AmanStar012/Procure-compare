import { Router } from "express";
import { db } from "@workspace/db";
import { projectsTable, quotationsTable, type Project } from "@workspace/db";
import { eq, count, sql } from "drizzle-orm";
import {
  GetProjectParams,
  DeleteProjectParams,
  CreateProjectBody,
  UpdateProjectParams,
  UpdateProjectBody,
} from "@workspace/api-zod";

const router = Router();

function serializeProject(project: Project) {
  return {
    ...project,
    targetItems: JSON.parse(project.targetItems) as string[],
    customColumns: JSON.parse(project.customColumns) as { id: string; label: string }[],
    columnLabels: JSON.parse(project.columnLabels) as Record<string, string>,
    createdAt: project.createdAt.toISOString(),
  };
}

// GET /api/projects — list all projects
router.get("/projects", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        description: projectsTable.description,
        targetItems: projectsTable.targetItems,
        customColumns: projectsTable.customColumns,
        columnLabels: projectsTable.columnLabels,
        createdAt: projectsTable.createdAt,
        quotationCount: count(quotationsTable.id),
        benchmarkQuotationId: sql<number | null>`(
          SELECT id FROM quotations WHERE project_id = ${projectsTable.id} AND is_benchmark = true LIMIT 1
        )`,
      })
      .from(projectsTable)
      .leftJoin(quotationsTable, eq(quotationsTable.projectId, projectsTable.id))
      .groupBy(projectsTable.id)
      .orderBy(sql`${projectsTable.createdAt} DESC`);

    res.json(
      rows.map((r) => ({
        ...r,
        targetItems: JSON.parse(r.targetItems) as string[],
        customColumns: JSON.parse(r.customColumns) as { id: string; label: string }[],
        columnLabels: JSON.parse(r.columnLabels) as Record<string, string>,
        createdAt: r.createdAt.toISOString(),
      }))
    );
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/projects — create project
router.post("/projects", async (req, res) => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error });
    return;
  }
  try {
    const [project] = await db
      .insert(projectsTable)
      .values({
        name: parsed.data.name,
        description: parsed.data.description,
        targetItems: JSON.stringify(parsed.data.targetItems),
      })
      .returning();
    res.status(201).json({
      ...serializeProject(project),
      quotationCount: 0,
      benchmarkQuotationId: null,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/projects/:id — get project detail with quotations
router.get("/projects/:id", async (req, res) => {
  const parsed = GetProjectParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const [project] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, parsed.data.id));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const quotations = await db
      .select()
      .from(quotationsTable)
      .where(eq(quotationsTable.projectId, project.id))
      .orderBy(quotationsTable.createdAt);

    const benchmarkQuotation = quotations.find((q) => q.isBenchmark);

    res.json({
      ...serializeProject(project),
      benchmarkQuotationId: benchmarkQuotation?.id ?? null,
      quotations: quotations.map((q) => ({
        ...q,
        createdAt: q.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/projects/:id — update name, description, or target categories
router.patch("/projects/:id", async (req, res) => {
  const parsedParams = UpdateProjectParams.safeParse({ id: Number(req.params.id) });
  const parsedBody = UpdateProjectBody.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const [existing] = await db.select().from(projectsTable).where(eq(projectsTable.id, parsedParams.data.id));
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { name, description, targetItems, customColumns, columnLabels } = parsedBody.data;
    const [updated] = await db
      .update(projectsTable)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(targetItems !== undefined ? { targetItems: JSON.stringify(targetItems) } : {}),
        ...(customColumns !== undefined ? { customColumns: JSON.stringify(customColumns) } : {}),
        ...(columnLabels !== undefined ? { columnLabels: JSON.stringify(columnLabels) } : {}),
      })
      .where(eq(projectsTable.id, parsedParams.data.id))
      .returning();

    const quotations = await db.select().from(quotationsTable).where(eq(quotationsTable.projectId, parsedParams.data.id));
    const benchmark = quotations.find((q) => q.isBenchmark);

    res.json({
      ...serializeProject(updated),
      quotationCount: quotations.length,
      benchmarkQuotationId: benchmark?.id ?? null,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/projects/:id
router.delete("/projects/:id", async (req, res) => {
  const parsed = DeleteProjectParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    await db.delete(projectsTable).where(eq(projectsTable.id, parsed.data.id));
    res.status(204).send();
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
