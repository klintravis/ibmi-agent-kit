# Option 5 shows the detail and status of each selected seed

Starts and ends on the list.

```5250-expect
text: Seed Stock List
fields: 8
```

Option 5 on Tomato (240 in stock).

```5250-do
type 9,3: 5
key: Enter
```

```5250-expect
text: Seed Detail
text: Tomato
text: In stock
not text: Seed Stock List
fields: 0
```

F12 returns to the list.

```5250-do
key: F12
```

```5250-expect
text: Seed Stock List
text: 8 seeds.
fields: 8
```

Two options in one Enter: Basil (12, low), then Kale (900, overstock), one detail after the other.

```5250-do
type 8,3: 5
type 14,3: 5
key: Enter
```

```5250-expect
text: Seed Detail
text: Basil
text: Low
not text: Kale
fields: 0
```

```5250-do
key: Enter
```

```5250-expect
text: Seed Detail
text: Kale
text: Overstock
not text: Basil
fields: 0
```

Enter on the last detail goes back to the list.

```5250-do
key: Enter
```

```5250-expect
text: Seed Stock List
text: 8 seeds.
fields: 8
```
