# SEEDLST lists every seed in the subfile

Starts on the list the session landed on: the title, the option legend, the rows with the status
from SeedStatus, the end marker and the count from SeedCount. The cursor waits in the first row's
option field.

```5250-expect
text: Seed Stock List
text: 5=Display
text: Sunflower
text: Sold out
text: Tomato
text: In stock
text: Kale
text: Overstock
text: Bottom
text: 8 seeds.
text: F3=Exit  F5=Refresh
fields: 8
cursor: 7,3
```

F5 reloads the same rows from the file.

```5250-do
key: F5
```

```5250-expect
text: Seed Stock List
text: 5=Display
text: Sunflower
text: Kale
text: Bottom
text: 8 seeds.
fields: 8
cursor: 7,3
```
