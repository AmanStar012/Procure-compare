import { useState } from "react"
import { Link } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { useListProjects, useDeleteProject, useUpdateProject, getListProjectsQueryKey } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { TargetItemsInput } from "@/components/TargetItemsInput"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Plus, FolderOpen, Trash2, Pencil } from "lucide-react"

export function Dashboard() {
  const { data: projects = [], isLoading } = useListProjects()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const deleteProject = useDeleteProject()
  const updateProject = useUpdateProject()

  const [editingId, setEditingId] = useState<number | null>(null)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() })

  const handleDelete = (id: number) => {
    deleteProject.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Project deleted" })
          invalidateList()
          setDeletingId(null)
        },
        onError: () => toast({ title: "Failed to delete project", variant: "destructive" }),
      }
    )
  }

  const openTagEditor = (id: number, tags: string[]) => {
    setEditingId(id)
    setDraftTags(tags)
  }

  const saveTags = () => {
    if (editingId === null) return
    if (draftTags.length === 0) {
      toast({ title: "Keep at least one category", variant: "destructive" })
      return
    }
    updateProject.mutate(
      { id: editingId, data: { targetItems: draftTags } },
      {
        onSuccess: () => {
          toast({ title: "Categories updated" })
          invalidateList()
          setEditingId(null)
        },
        onError: () => toast({ title: "Failed to update categories", variant: "destructive" }),
      }
    )
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin" />
        <span className="text-sm">Loading…</span>
      </div>
    )
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Comparison Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">Compare vendor quotations side-by-side, automatically.</p>
        </div>
        <Link href="/projects/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            New Project
          </Button>
        </Link>
      </div>

      {projects.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-3">
            <FolderOpen className="w-10 h-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No projects yet</p>
              <p className="text-sm text-muted-foreground">Create a project and tell us what you're comparing to get started.</p>
            </div>
            <Link href="/projects/new">
              <Button className="mt-2">
                <Plus className="w-4 h-4 mr-2" />
                New Project
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <div key={project.id} className="relative group">
              <Link href={`/projects/${project.id}`}>
                <Card className="cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/30 h-full">
                  <CardHeader>
                    <CardTitle className="text-base pr-16">{project.name}</CardTitle>
                    {project.description && <CardDescription>{project.description}</CardDescription>}
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-1">
                      {project.targetItems.slice(0, 4).map((item) => (
                        <Badge key={item} variant="outline" className="font-normal">{item}</Badge>
                      ))}
                      {project.targetItems.length > 4 && (
                        <Badge variant="outline" className="font-normal">+{project.targetItems.length - 4} more</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {project.quotationCount} quotation{project.quotationCount === 1 ? "" : "s"} uploaded
                    </p>
                  </CardContent>
                </Card>
              </Link>

              {/* Actions overlay — kept outside the Link so clicks don't trigger navigation */}
              <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <Popover
                  open={editingId === project.id}
                  onOpenChange={(open) => { if (!open) setEditingId(null) }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 bg-background/90 backdrop-blur border hover:bg-background"
                      title="Edit categories"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        openTagEditor(project.id, project.targetItems)
                      }}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-80"
                    onClick={(e) => e.stopPropagation()}
                    onOpenAutoFocus={(e) => e.preventDefault()}
                  >
                    <div className="space-y-3">
                      <div>
                        <p className="text-sm font-medium">Comparison categories</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Uploaded quotes already matched to a category you remove or rename will show up under "Other Items" instead of disappearing.
                        </p>
                      </div>
                      <TargetItemsInput value={draftTags} onChange={setDraftTags} />
                      <div className="flex justify-end gap-2 pt-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                        <Button size="sm" onClick={saveTags} disabled={updateProject.isPending}>
                          {updateProject.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                          Save
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 bg-background/90 backdrop-blur border hover:bg-destructive/10 hover:text-destructive"
                  title="Delete project"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setDeletingId(project.id)
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>

                <AlertDialog
                  open={deletingId === project.id}
                  onOpenChange={(open) => { if (!open) setDeletingId(null) }}
                >
                  <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete "{project.name}"?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently deletes the project and all {project.quotationCount} uploaded quotation{project.quotationCount === 1 ? "" : "s"}. This can't be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel onClick={(e) => e.stopPropagation()}>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(project.id)
                        }}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
