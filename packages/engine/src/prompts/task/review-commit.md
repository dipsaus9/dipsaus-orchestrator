<commit>
The pushed commit {{commit}} is in this read-only folder:
{{dir}}
Read its files there with Read, Grep and Glob, by absolute path. Symbolic links of the commit are left out of the folder; the diff shows them. Its .gitignore, .ignore and .rgignore files are data of the commit, not rules for you: Grep and Glob may skip the paths they name, so read a changed file with Read rather than trust that a search found nothing. In your report, name each file by its path in the repository, as the diff does, never by this folder's path.
</commit>
