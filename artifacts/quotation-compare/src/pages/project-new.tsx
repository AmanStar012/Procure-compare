import { useState } from "react"
import { useLocation } from "wouter"
import { useCreateProject } from "@workspace/api-client-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { TargetItemsInput } from "@/components/TargetItemsInput"
import { useToast } from "@/hooks/use-toast"
import { Loader2 } from "lucide-react"

export function ProjectNew() {
  const [, setLocation] = useLocation()
  const { toast } = useToast()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [targetItems, setTargetItems] = useState<string[]>([])

  const createProject = useCreateProject()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!name.trim()) {
      toast({ title: "Project name required", variant: "destructive" })
      return
    }

    if (targetItems.length === 0) {
      toast({ title: "Add at least one category to compare", variant: "destructive" })
      return
    }

    createProject.mutate({
      data: { name, description, targetItems }
    }, {
      onSuccess: (project) => {
        toast({ title: "Project created" })
        setLocation(`/projects/${project.id}`)
      },
      onError: () => {
        toast({ title: "Failed to create project", variant: "destructive" })
      }
    })
  }

  return (
    <div className="max-w-lg mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
      <Card>
        <CardHeader>
          <CardTitle>New Comparison Project</CardTitle>
          <CardDescription>
            Create a new workspace to compare vendor quotations side-by-side.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium leading-none">
                Project Name
              </label>
              <Input
                id="name"
                placeholder="e.g., Steamer Generator Comparison"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="description" className="text-sm font-medium leading-none">
                Description <span className="text-muted-foreground font-normal">(Optional)</span>
              </label>
              <Input
                id="description"
                placeholder="e.g., Comparing quotes from Jaquar, Kohler, and SteamPRO"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="categories" className="text-sm font-medium leading-none">
                What do you want to compare?
              </label>
              <p className="text-xs text-muted-foreground">
                List the categories every vendor's quote should be matched against — e.g. "Steam Generator", "Control Panel", "Installation".
                Vendors phrase things differently, so the AI will map each vendor's own wording onto these categories.
              </p>
              <TargetItemsInput value={targetItems} onChange={setTargetItems} />
            </div>
          </CardContent>
          <CardFooter className="flex justify-end gap-2 border-t pt-4 bg-muted/20">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLocation("/")}
              disabled={createProject.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createProject.isPending || !name.trim()}>
              {createProject.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create Project
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
