import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  targetItems: text("target_items").notNull(), // JSON string array — canonical categories to compare across vendors
  customColumns: text("custom_columns").notNull().default("[]"), // JSON: {id, label}[] — extra shared columns added in the grid editor
  columnLabels: text("column_labels").notNull().default("{}"), // JSON: overrides for the built-in header labels (spec/qty/mrp/unitPrice/discountPercent/totalPrice)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
