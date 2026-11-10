git could not merge {{base}} at {{onto}} into your branch cleanly. dipo committed the merge as git left it in its own copy of the branch and copied it into your box.
Conflicted files: {{files}}
{{help}}
The conflicts as git left them:
<diff>
{{hunks}}
</diff>
Resolve every conflicted file in your box: keep both changes where they belong and remove every conflict marker line. Then run the tests, hand a part with dipo-part, and report done again. dipo does not move the story to review while a conflict marker line remains in one of these files.
