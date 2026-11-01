**free
// SEEDPR - prototypes for service program SEEDSRV
dcl-ds Seed_t qualified template;
  id packed(5:0);
  name char(30);
  qty packed(7:0);
end-ds;

// Read one seed by id; *off when it does not exist
dcl-pr SeedGet ind extproc(*dclcase);
  id packed(5:0) const;
  seed likeds(Seed_t);
end-pr;

// Number of seeds in SEEDS
dcl-pr SeedCount int(10) extproc(*dclcase);
end-pr;

// Status text for a quantity
dcl-pr SeedStatus varchar(10) extproc(*dclcase);
  qty packed(7:0) const;
end-pr;
